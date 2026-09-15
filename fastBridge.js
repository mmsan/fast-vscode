const vscode = require('vscode')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
const WebSocket = require('ws')

const uuid = () => crypto.randomUUID()
const execFileAsync = promisify(execFile)
const pythonPackageName = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const slowReconnectAfterMs = 5 * 60 * 1000
const slowReconnectDelayMs = 6000
const connectionLogIntervalMs = 60 * 1000
const maxLogFileBytes = 5 * 1024 * 1024
const logBackupCount = 2
const compactLogText = value => {
  if (value === undefined || value === null || !String(value).trim()) return ''
  const text = String(value).replace(/bearer\s+\S+/ig, 'Bearer <redacted>').replace(/[\r\n]+/g, ' ').trim()
  return text.length <= 500 ? text : `${text.slice(0, 500)}...`
}

function projectId(basePath) {
  const bytes = crypto.createHash('md5').update(path.resolve(basePath || '').toLowerCase()).digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const value = bytes.toString('hex')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

const pythonPackageQuery = [
  'import importlib.util, importlib.metadata, json, os, sys',
  'items = {}',
  'for item in sys.argv[1:]:',
  "    import_name, distribution_name = item.split('\\t', 1)",
  '    installed = False',
  '    version = None',
  '    try: installed = importlib.util.find_spec(import_name) is not None',
  '    except (ImportError, ModuleNotFoundError, ValueError): pass',
  '    try:',
  '        version = importlib.metadata.version(distribution_name)',
  '        installed = True',
  '    except importlib.metadata.PackageNotFoundError: pass',
  "    items[import_name] = {'installed': installed, **({'version': version} if version else {})}",
  "environment_type = 'conda' if os.environ.get('CONDA_PREFIX') else ('venv' if sys.prefix != getattr(sys, 'base_prefix', sys.prefix) else 'system')",
  "print(json.dumps({'interpreter': sys.executable, 'version': '.'.join(str(part) for part in sys.version_info[:3]), 'environmentType': environment_type, 'packages': items}))",
].join('\n')

function inputTopOffset(text, python) {
  let offset = 0
  let blockComment = false
  while (offset < text.length) {
    const lineEnd = text.indexOf('\n', offset)
    const contentEnd = lineEnd < 0 ? text.length : lineEnd
    const line = text.slice(offset, contentEnd).replace(/\r$/, '')
    let trimmed = line.trim()
    if (blockComment) {
      const close = trimmed.indexOf('*/')
      if (close < 0) {
        offset = lineEnd < 0 ? text.length : lineEnd + 1
        continue
      }
      blockComment = false
      trimmed = trimmed.slice(close + 2).trim()
      if (!trimmed || trimmed.startsWith('//') || (python && trimmed.startsWith('#'))) {
        offset = lineEnd < 0 ? text.length : lineEnd + 1
        continue
      }
      return offset
    }
    if (trimmed.startsWith('//') || (python && trimmed.startsWith('#'))) {
      offset = lineEnd < 0 ? text.length : lineEnd + 1
      continue
    }
    if (trimmed.startsWith('/*')) {
      const close = trimmed.indexOf('*/', 2)
      if (close < 0) blockComment = true
      else if (trimmed.slice(close + 2).trim()) return offset
      offset = lineEnd < 0 ? text.length : lineEnd + 1
      continue
    }
    return offset
  }
  return offset
}

function syntaxContextAt(text, offset, languageId) {
  const stack = []
  const isPython = /^(python|cython)$/.test(languageId || '')
  const isWord = value => /[A-Za-z0-9_$]/.test(value)
  const previousWord = index => {
    let end = index
    while (end >= 0 && /\s/.test(text[end])) end--
    let start = end
    while (start >= 0 && isWord(text[start])) start--
    return text.slice(start + 1, end + 1)
  }
  const objectBrace = index => {
    if (/^(json|jsonc)$/.test(languageId || '')) return 'braces'
    const before = text.slice(Math.max(0, index - 12), index).trimEnd()
    const word = previousWord(index - 1)
    if (/^(if|for|while|switch|catch|try|finally|class|function|else|do)$/.test(word)) return 'block'
    if (/\b(if|for|while|switch|catch|function|class)\s*\([^)]*\)$/.test(before)) return 'block'
    if (/[=,:([{]|=>\s*$/.test(before.slice(-1)) || /=>\s*$/.test(before)) return 'braces'
    return 'block'
  }
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < Math.min(Math.max(0, offset), text.length); index++) {
    const current = text[index]
    const next = text[index + 1]
    if (lineComment) {
      if (current === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (current === '*' && next === '/') { blockComment = false; index++ }
      continue
    }
    if (quote) {
      if (escaped) { escaped = false; continue }
      if (current === '\\') { escaped = true; continue }
      if (current === quote) { quote = null; continue }
      continue
    }
    if (current === '/' && next === '/') { lineComment = true; index++; continue }
    if (current === '/' && next === '*') { blockComment = true; index++; continue }
    if (isPython && current === '#') { lineComment = true; continue }
    if (current === "'" || current === '"' || current === '`') { quote = current; continue }
    if (current === '{') stack.push(objectBrace(index))
    else if (current === '(') stack.push('parentheses')
    else if (current === '[') stack.push('bracket')
    else if (current === '}' || current === ')' || current === ']') stack.pop()
  }
  if (quote === "'") return 'singleQuote'
  if (quote === '"') return 'doubleQuote'
  if (quote === '`') return 'backtick'
  const current = stack[stack.length - 1]
  return current === 'braces' || current === 'parentheses' ? current : 'none'
}

function extractExpression(text, offset) {
  if (!text) return ''
  let cursor = Math.max(0, Math.min(offset, text.length))
  let end = cursor
  while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end++
  let start = cursor
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1])) start--
  const matchingOpen = (close, open, closing) => {
    let depth = 0
    for (let index = close; index >= 0; index--) {
      if (text[index] === closing) depth++
      else if (text[index] === open && --depth === 0) return index
    }
    return -1
  }
  while (start > 0) {
    let index = start - 1
    while (index >= 0 && /\s/.test(text[index])) index--
    if (text[index] !== '.') break
    index--
    while (index >= 0 && /\s/.test(text[index])) index--
    if (text[index] === ')') {
      const open = matchingOpen(index, '(', ')')
      if (open < 0) break
      let nameEnd = open
      let nameStart = nameEnd - 1
      while (nameStart >= 0 && /[A-Za-z0-9_$]/.test(text[nameStart])) nameStart--
      start = nameStart + 1
    } else {
      while (index >= 0 && /[A-Za-z0-9_$]/.test(text[index])) index--
      start = index + 1
    }
  }
  const value = text.slice(start, end).replace(/\s+/g, '')
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\([^\n\r]*\))*\.?$/.test(value) ? value : ''
}

function hoverType(hover) {
  const values = []
  for (const item of hover?.contents || []) values.push(typeof item === 'string' ? item : item?.value || '')
  const text = values.join('\n').replace(/```[^\n]*\n?|```/g, '').trim()
  if (!text) return ''
  const line = text.split(/\r?\n/).find(value => /[:()]|\b(class|interface|function|method|property)\b/i.test(value)) || text.split(/\r?\n/)[0]
  const match = line.match(/:\s*([^\n]+)$/)
  return (match ? match[1] : line).trim().replace(/^\([^)]*\)\s*/, '')
}

function hoverInfo(hover) {
  const values = []
  for (const item of hover?.contents || []) values.push(typeof item === 'string' ? item : item?.value || '')
  const text = values.join('\n').replace(/```[^\n]*\n?|```/g, '').trim()
  if (!text) return {}
  const line = text.split(/\r?\n/).find(value => /[:()]|\b(class|interface|function|method|property)\b/i.test(value)) || text.split(/\r?\n/)[0]
  const method = line.match(/\)\s*(?::|->)\s*([^\n]+)/)
  const type = hoverType(hover)
  const result = {}
  if (type) result.type = type
  if (method) {
    result.kind = 'method'
    result.returnType = method[1].trim()
    result.type = result.returnType
  } else if (/\b(property|field)\b/i.test(line)) {
    result.kind = 'property'
  } else if (/\b(class|interface|type)\b/i.test(line)) {
    result.kind = 'type'
  }
  return result
}

function completionSignature(detail) {
  if (typeof detail !== 'string' || !detail.trim()) return {}
  const text = detail.replace(/```[^\n]*\n?|```/g, '').trim()
  const result = {}
  const method = text.match(/\(([^)]*)\)\s*(?::|->)\s*([^\n]+)/)
  if (method) {
    result.returnType = method[2].trim()
    result.parameters = method[1].split(',').map(value => value.trim()).filter(Boolean).map(value => {
      const match = value.match(/^([^:]+):\s*(.+)$/)
      return match ? {name: match[1].trim(), type: match[2].trim()} : {name: value}
    })
  }
  return result
}

function completionMembers(completion) {
  const result = []
  const seen = new Set()
  for (const item of completion?.items || []) {
    const name = typeof item.label === 'string' ? item.label : item.label?.label
    if (!name || seen.has(name) || result.length >= 15) continue
    seen.add(name)
    const kind = {2: 'method', 3: 'method', 4: 'method', 5: 'property', 6: 'variable', 7: 'type', 8: 'type', 10: 'property'}[item.kind] || 'member'
    const member = {name, kind}
    const signature = completionSignature(item.detail)
    if (kind === 'method') {
      if (signature.returnType) member.returnType = signature.returnType
      if (signature.parameters?.length) member.parameters = signature.parameters
      if (signature.returnType) member.type = signature.returnType
    } else if (typeof item.detail === 'string' && item.detail.trim()) {
      member.type = item.detail.trim()
    }
    result.push(member)
  }
  return result
}

function objectInfo(activeEditor) {
  if (!activeEditor) return null
  return {
    project: activeEditor.project || null,
    file: activeEditor.file || null,
    context: activeEditor.context || 'none',
    expressionContext: activeEditor.expressionContext || null,
  }
}

function isInputable(snapshot) {
  const focus = snapshot?.focus
  const editor = snapshot?.activeEditor
  const available = !!focus && focus.enabled !== false &&
    focus.visible !== false && focus.showing !== false
  return available && (
    focus.type === 'textInput' && focus.input?.editable === true ||
    focus.type === 'editor' && editor?.ownsFocus === true && editor?.editable === true
  )
}

function statusFromSnapshot(snapshot) {
  return {
    inputable: isInputable(snapshot),
    focus: snapshot?.focus || {type: 'none'},
    activeEditor: snapshot?.activeEditor || null,
    objectInfo: objectInfo(snapshot?.activeEditor),
  }
}

function statusSignature(status) {
  return JSON.stringify({
    inputable: status.inputable,
    focus: {
      type: status.focus?.type || 'none',
      className: status.focus?.className || '',
      ownsFocus: status.activeEditor?.ownsFocus === true,
    },
    objectInfo: status.objectInfo,
  })
}

const focusContextKeys = [
  'editorFocus',
  'editorTextFocus',
  'inputFocus',
  'textInputFocus',
  'findInputFocussed',
  'searchInputBoxFocus',
  'filesExplorerFocus',
  'explorerViewletFocus',
  'sideBarFocus',
  'activeViewlet',
]

function contextKeyIsTrue(value) {
  return value === true || value === 'true'
}

function contextKeyIsKnown(value) {
  return value !== undefined && value !== null
}

class FastBridge {
  constructor(context) {
    this.context = context
    this.instanceId = uuid()
    this.connectionId = uuid()
    this.sequence = 0
    this.generation = 0
    this.reconnectAttempt = 0
    this.connectionFailures = 0
    this.reconnectStartedAt = 0
    this.slowReconnectLogged = false
    this.connectionLogStates = new Map()
    this.startupFullscreenHandshakeSent = false
    this.editorOpenedKey = null
    this.editorOpenedAt = 0
    this.pendingStatus = null
    this.statusInFlight = null
    this.focusPoll = null
    this.lastStatusSignature = null
    this.lastSelectedText = null
    this.output = this.createOutputChannel()
    this.logDirectory = (this.context.logUri || this.context.globalStorageUri || this.context.storageUri)?.fsPath || ''
  }

  createOutputChannel() {
    try {
      return vscode.window.createOutputChannel('Fast Bridge', { log: true })
    } catch (error) {
      return vscode.window.createOutputChannel('Fast Bridge')
    }
  }

  async start() {
    this.context.subscriptions.push(
      this.output,
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.schedule('focus.changed', 0)
        this.scheduleStatus(0)
      }),
      vscode.window.onDidChangeWindowState(() => {
        this.schedule('focus.changed', 0)
        this.scheduleStatus(0)
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.schedule('focus.changed', 0)
        this.scheduleStatus(0)
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => {
        this.schedule('focus.changed', 0)
        this.scheduleStatus(0)
      }),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleStatus(40)),
      vscode.workspace.onDidChangeTextDocument(() => this.scheduleStatus(100)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reconnect()),
      vscode.workspace.onDidChangeConfiguration(event => event.affectsConfiguration('fastBridge') && this.reconnect()),
      vscode.commands.registerCommand('fastBridge.reconnect', () => this.reconnect()),
      vscode.commands.registerCommand('fastBridge.showOutput', () => this.output.show()),
      vscode.commands.registerCommand('fastBridge.copySelectedResourcePath', () => this.copyResourcePath(true)),
      { dispose: () => this.dispose() },
    )
    this.log(`service started; autoConnect=${this.settings().autoConnect}`)
    if (this.settings().autoConnect) this.connect()
  }

  settings() {
    const config = vscode.workspace.getConfiguration('fastBridge')
    return {
      host: config.get('host', '127.0.0.1'),
      port: config.get('port', 19900),
      path: config.get('path', ''),
      token: config.get('token', ''),
      autoConnect: config.get('autoConnect', true),
      sendText: config.get('sendText', true),
      contextCharacters: config.get('contextCharacters', 200),
    }
  }

  projects() {
    return (vscode.workspace.workspaceFolders || []).map(folder => ({
      projectId: projectId(folder.uri.fsPath),
      name: folder.name,
      basePath: folder.uri.fsPath,
    }))
  }

  reconnect() {
    this.generation++
    this.reconnectAttempt = 0
    this.reconnectStartedAt = 0
    this.slowReconnectLogged = false
    this.log('settings changed; reconnecting')
    this.stopFocusPolling()
    if (this.socket) this.socket.close(1000, 'settings changed')
    this.socket = null
    if (!this.disposed && this.settings().autoConnect) this.connect()
  }

  connect() {
    const generation = this.generation
    const settings = this.settings()
    const socketPath = settings.path ? (settings.path.startsWith('/') ? settings.path : `/${settings.path}`) : ''
    const headers = { 'X-Idea-Bridge-Version': '1', 'X-Fast-Bridge-Client': 'vscode' }
    if (settings.token.trim()) headers.Authorization = `Bearer ${settings.token.trim()}`
    let socket
    try {
      socket = new WebSocket(`ws://${settings.host.trim()}:${settings.port}${socketPath}`, { headers, handshakeTimeout: 1000 })
    } catch (error) {
      this.log(`connection configuration failed: ${error.message}`, 'error')
      return
    }
    let opened = false
    socket.on('open', async () => {
      if (generation !== this.generation || this.disposed) return socket.close()
      this.socket = socket
      this.connectionId = uuid()
      this.reconnectAttempt = 0
      this.reconnectStartedAt = 0
      this.slowReconnectLogged = false
      this.lastStatusSignature = null
      opened = true
      const failures = this.connectionFailures
      this.connectionFailures = 0
      this.log(`connected${failures > 0 ? `; recoveredAfterFailures=${failures}` : ''}`)
      const identity = await this.identity()
      if (!this.startupFullscreenHandshakeSent) {
        this.startupFullscreenHandshakeSent = true
        identity.startupFullScreenUntil = Date.now() + 8000
      }
      this.send('bridge.hello', identity)
      this.schedule('editor.state', 0)
      this.scheduleStatus(0)
      this.startFocusPolling()
    })
    socket.on('message', data => {
      if (data.length > 1024 * 1024) return socket.close(1009, 'message too large')
      this.handle(data.toString()).catch(error => this.log(error.stack || error.message, 'error'))
    })
    socket.on('error', error => this.recordConnectionFailure(error))
    socket.on('close', (code, reason) => {
      if (this.socket === socket) {
        this.socket = null
        this.stopFocusPolling()
      }
      if (this.disposed || generation !== this.generation || !this.settings().autoConnect) return
      if (opened) this.logConnectionEvent('closed', `connection closed; code=${code}; reason=${reason?.toString() || ''}`)
      const delays = [200, 500, 1000, 2000]
      const attempt = this.reconnectAttempt++
      if (!this.reconnectStartedAt) this.reconnectStartedAt = Date.now()
      const retryingForMs = Date.now() - this.reconnectStartedAt
      const delay = retryingForMs >= slowReconnectAfterMs
        ? slowReconnectDelayMs
        : delays[Math.min(attempt, delays.length - 1)]
      if (delay === slowReconnectDelayMs && !this.slowReconnectLogged) {
        this.slowReconnectLogged = true
        this.log(`connection remains unavailable for ${Math.floor(retryingForMs / 1000)}s; retry delay increased to ${slowReconnectDelayMs}ms`, 'warn')
      }
      setTimeout(() => generation === this.generation && this.connect(), delay)
    })
  }

  recordConnectionFailure(error) {
    const count = ++this.connectionFailures
    this.logConnectionEvent('failure', `connection failed; attempt=${count}; ${error?.message || error}`, 'warn')
  }

  logConnectionEvent(kind, text, level = 'warn') {
    const now = Date.now()
    const state = this.connectionLogStates.get(kind) || { count: 0, lastAt: 0, suppressed: 0 }
    state.count++
    const shouldLog = state.count <= 3 || now - state.lastAt >= connectionLogIntervalMs
    if (shouldLog) {
      const suffix = state.suppressed > 0 ? `; suppressed=${state.suppressed}` : ''
      state.lastAt = now
      state.suppressed = 0
      this.log(`${text}${suffix}`, level)
    } else {
      state.suppressed++
    }
    this.connectionLogStates.set(kind, state)
  }

  async identity() {
    const snapshot = await this.snapshot()
    return {
      client: 'fast-vscode-bridge',
      instanceId: this.instanceId,
      connectionId: this.connectionId,
      projects: this.projects(),
      processId: process.pid,
      fullScreen: snapshot.fullScreen,
      editorOpenedAt: snapshot.editorOpenedAt,
      activeProject: snapshot.activeEditor?.project || null,
      capabilities: ['state', 'getInputable', 'getContext', 'getObjectInfo', 'getSelectedText', 'getCurrentLineContent', 'navigate', 'select', 'find', 'deleteSelection', 'input', 'requestFocus', 'fullScreen', 'isFullScreen', 'listProjects', 'copyResourcePath', 'pythonPackages', 'ctrlW', 'ctrlShiftW', 'shiftHome', 'home', 'end', 'direction', 'inputTop', 'shiftDown', 'shiftUp', 'moveUpIfLastLine', 'executeIdeCommand'],
    }
  }

  send(type, payload, replyTo) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    const source = {
      instanceId: this.instanceId,
      connectionId: this.connectionId,
      projects: this.projects(),
    }
    const project = payload && payload.activeEditor && payload.activeEditor.project
    if (project) Object.assign(source, {
      projectId: project.projectId,
      projectName: project.name,
      projectBasePath: project.basePath,
    })
    const message = {
      version: 1,
      id: uuid(),
      type,
      timestamp: Date.now(),
      sequence: ++this.sequence,
      payload,
      source,
    }
    if (replyTo) message.replyTo = replyTo
    try {
      this.socket.send(JSON.stringify(message))
    } catch (error) {
      this.log(`message send failed; type=${type}; ${error.message}`, 'warn')
    }
  }

  schedule(type, delay) {
    clearTimeout(this.pending)
    this.pending = setTimeout(async () => {
      try {
        this.send(type, await this.snapshot())
      } catch (error) {
        this.log(`读取当前资源失败：${error.message}`, 'warn')
      }
    }, delay)
  }

  scheduleStatus(delay) {
    clearTimeout(this.pendingStatus)
    this.pendingStatus = setTimeout(async () => {
      this.pendingStatus = null
      try {
        await this.publishStatus()
      } catch (error) {
        this.log(`读取当前编辑器状态失败：${error.message}`, 'warn')
      }
    }, delay)
  }

  async publishStatus() {
    if (this.statusInFlight) return this.statusInFlight
    const task = (async () => {
      const status = statusFromSnapshot(await this.snapshot())
      const signature = statusSignature(status)
      if (signature === this.lastStatusSignature) return
      this.lastStatusSignature = signature
      this.send('editor.statusChanged', status)
    })()
    this.statusInFlight = task
    try {
      return await task
    } finally {
      if (this.statusInFlight === task) this.statusInFlight = null
    }
  }

  startFocusPolling() {
    this.stopFocusPolling()
    this.focusPoll = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
      this.publishStatus().catch(error => {
        this.log(`读取当前编辑器焦点失败：${error.message}`, 'warn')
      })
    }, 500)
  }

  stopFocusPolling() {
    clearInterval(this.focusPoll)
    this.focusPoll = null
  }

  async snapshot() {
    const editor = vscode.window.activeTextEditor
    const resource = editor ? editor.document.uri : await this.activeResourceUri()
    const editorOpenedAt = this.getEditorOpenedAt(editor, resource)
    const resourceFolder = resource ? vscode.workspace.getWorkspaceFolder(resource) : null
    const activeResource = resource && resource.scheme === 'file'
      ? {
        path: resource.fsPath,
        url: resource.toString(),
        name: path.basename(resource.fsPath),
        ...(resourceFolder
          ? { project: { projectId: projectId(resourceFolder.uri.fsPath), name: resourceFolder.name, basePath: resourceFolder.uri.fsPath } }
          : {}),
      }
      : null
    const [fullScreenState, focusContext] = await Promise.all([
      this.isFullScreen(),
      this.focusContext(),
    ])
    const fullScreen = fullScreenState.fullScreen
    const hasEditorFocus = editor
      ? focusContext.known ? focusContext.editorFocused : true
      : false
    const focus = editor
      ? hasEditorFocus
        ? { type: 'editor', className: 'vscode.TextEditor', enabled: true, visible: true, showing: true }
        : focusContext.inputFocused
          ? this.textInputFocus()
          : this.componentFocus(focusContext)
      : resource
        ? focusContext.inputFocused
          ? this.textInputFocus()
          : { type: 'editor', className: 'vscode.ResourceEditor', enabled: true, visible: true, showing: true }
        : focusContext.inputFocused
          ? this.textInputFocus()
          : { type: 'none' }
    return {
      focus,
      activeEditor: editor
        ? await this.describe(editor, hasEditorFocus)
        : resource ? this.describeResource(resource, !focusContext.known || focusContext.editorFocused) : null,
      activeResource,
      editorOpenedAt,
      // An unavailable context key is unknown, not "not fullscreen". Treating
      // it as false would make the toggle command shrink the window.
      fullScreen,
    }
  }

  async focusContext() {
    const values = await Promise.all(focusContextKeys.map(key => this.contextKeyValue(key)))
    const context = Object.fromEntries(focusContextKeys.map((key, index) => [key, values[index]]))
    const inputFocused = [
      context.inputFocus,
      context.textInputFocus,
      context.findInputFocussed,
      context.searchInputBoxFocus,
    ].some(contextKeyIsTrue)
    const explorerFocused = [
      context.filesExplorerFocus,
      context.explorerViewletFocus,
    ].some(contextKeyIsTrue) ||
      contextKeyIsTrue(context.sideBarFocus) && context.activeViewlet === 'workbench.view.explorer'
    const sidebarFocused = contextKeyIsTrue(context.sideBarFocus)
    const editorTextFocusKnown = contextKeyIsKnown(context.editorTextFocus)
    const editorFocusKnown = contextKeyIsKnown(context.editorFocus)
    const known = editorFocusKnown || focusContextKeys.some(key => contextKeyIsKnown(context[key]))
    const editorFocused = vscode.window.state.focused && (editorTextFocusKnown
      ? contextKeyIsTrue(context.editorTextFocus)
      : editorFocusKnown
        ? contextKeyIsTrue(context.editorFocus) && !inputFocused && !sidebarFocused && !explorerFocused
        : !inputFocused && !sidebarFocused && !explorerFocused)
    return {known, editorFocused, inputFocused, explorerFocused}
  }

  textInputFocus() {
    return {
      type: 'textInput',
      className: 'vscode.InputBox',
      enabled: true,
      visible: true,
      showing: true,
      input: {editable: true},
    }
  }

  componentFocus(focusContext) {
    return {
      type: 'component',
      className: focusContext.explorerFocused ? 'vscode.FilesExplorer' : 'vscode.Component',
      enabled: true,
      visible: true,
      showing: true,
    }
  }

  async currentSelectedText() {
    const editor = vscode.window.activeTextEditor
    if (!editor || !this.settings().sendText) return null
    const selectedText = editor.selection.isEmpty ? '' : editor.document.getText(editor.selection)
    if (selectedText !== this.lastSelectedText) {
      this.lastSelectedText = selectedText
      return selectedText
    }
    const pollIntervalMs = 30
    const maxWaitMs = 200
    for (let elapsedMs = 0; elapsedMs < maxWaitMs;) {
      const delayMs = Math.min(pollIntervalMs, maxWaitMs - elapsedMs)
      await new Promise(resolve => setTimeout(resolve, delayMs))
      elapsedMs += delayMs
      const refreshedEditor = vscode.window.activeTextEditor
      if (!refreshedEditor || !this.settings().sendText) {
        if (elapsedMs >= maxWaitMs) return selectedText
        continue
      }
      const refreshedText = refreshedEditor.selection.isEmpty ? '' : refreshedEditor.document.getText(refreshedEditor.selection)
      if (refreshedText !== selectedText || elapsedMs >= maxWaitMs) {
        this.lastSelectedText = refreshedText
        return refreshedText
      }
    }
    return selectedText
  }

  async currentLineContent() {
    const editor = vscode.window.activeTextEditor
    if (!editor || !this.settings().sendText) return null
    const [editorFocus, editorTextFocus] = await Promise.all([
      this.contextKeyValue('editorFocus'),
      this.contextKeyValue('editorTextFocus'),
    ])
    if (contextKeyIsKnown(editorFocus) || contextKeyIsKnown(editorTextFocus)) {
      if (!contextKeyIsTrue(editorFocus) && !contextKeyIsTrue(editorTextFocus)) return null
    } else if (!(await this.focusContext()).editorFocused) return null
    return editor.document.lineAt(editor.selection.active.line).text
  }

  async deleteSelection(expectedText) {
    const editor = vscode.window.activeTextEditor
    if (!editor) throw Object.assign(new Error('No active text editor'), {code: 'NO_EDITOR'})
    if (typeof expectedText !== 'string') throw Object.assign(new Error('payload.expectedText is required'), {code: 'INVALID_MESSAGE'})
    if (editor.document.getText(editor.selection) !== expectedText) return {handled: true, matched: false, deleted: false}
    if (!await editor.edit(edit => edit.delete(editor.selection))) throw new Error('Unable to delete the editor selection')
    return {handled: true, matched: true, deleted: true}
  }

  async input(text) {
    const editor = vscode.window.activeTextEditor
    if (!editor) throw Object.assign(new Error('No active text editor'), {code: 'NO_EDITOR'})
    if (typeof text !== 'string') throw Object.assign(new Error('payload.text is required'), {code: 'INVALID_MESSAGE'})
    if (!await editor.edit(edit => editor.selections.forEach(selection => edit.replace(selection, text)))) {
      throw new Error('Unable to insert text into the active editor')
    }
    return {handled: true}
  }

  /** Executes a registered VS Code command. */
  async executeIdeCommand(payload) {
    const commandId = typeof payload.commandId === 'string' ? payload.commandId.trim() : ''
    const args = payload.args === undefined || payload.args === null ? [] : payload.args
    if (!commandId) throw Object.assign(new Error('payload.commandId must be a non-empty string'), {code: 'INVALID_COMMAND'})
    if (!Array.isArray(args)) throw Object.assign(new Error('payload.args must be an array'), {code: 'INVALID_COMMAND_ARGS'})
    if (!(await vscode.commands.getCommands(true)).includes(commandId)) {
      throw Object.assign(new Error(`VS Code command not found: ${commandId}`), {code: 'COMMAND_NOT_FOUND'})
    }
    return vscode.commands.executeCommand(commandId, ...args)
  }

  async currentInputable() {
    return isInputable(await this.snapshot())
  }

 async currentContext() {
    const editor = vscode.window.activeTextEditor
    if (!editor) return null
    const offset = editor.document.offsetAt(editor.selection.active)
    return syntaxContextAt(editor.document.getText(), offset, editor.document.languageId)
 }

  async currentObjectInfo() {
    return objectInfo((await this.snapshot()).activeEditor)
  }

  getEditorOpenedAt(editor, resource) {
    const key = editor || (resource ? resource.toString() : null)
    if (!key) return 0
    if (key !== this.editorOpenedKey) {
      this.editorOpenedKey = key
      this.editorOpenedAt = Date.now()
    }
    return this.editorOpenedAt
  }

  async activeResourceUri() {
    const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab
    const uri = tab?.input?.uri
    if (uri && typeof uri.fsPath === 'string') return uri
    const value = await this.contextKeyValue('resource')
    if (typeof value !== 'string' || !/^file:/i.test(value)) return null
    try {
      return vscode.Uri.parse(value)
    } catch (error) {
      return null
    }
  }

  describeResource(uri, ownsFocus = true) {
    const folder = vscode.workspace.getWorkspaceFolder(uri)
    const filePath = uri.scheme === 'file' ? uri.fsPath : ''
    const name = path.basename(filePath || uri.path || uri.toString())
    return {
      ownsFocus,
      editable: false,
      file: {
        name,
        path: filePath,
        url: uri.toString(),
        writable: false,
        fileType: path.extname(name).replace(/^\./, ''),
        projectRelativePath: folder && filePath
          ? path.relative(folder.uri.fsPath, filePath).replace(/\\/g, '/')
          : undefined,
      },
      caret: {
        offset: 0,
        line: 0,
        column: 0,
        lineNumber: 1,
        columnNumber: 1,
        visualLine: 0,
        visualColumn: 0,
      },
      selection: { hasSelection: false, startOffset: 0, endOffset: 0 },
      carets: [],
      ...(folder ? { project: { projectId: projectId(folder.uri.fsPath), name: folder.name, basePath: folder.uri.fsPath } } : {}),
    }
  }

  async describe(editor, ownsFocus = true) {
    const document = editor.document
    const selection = editor.selection
    const folder = vscode.workspace.getWorkspaceFolder(document.uri)
    const offset = document.offsetAt(selection.active)
    const settings = this.settings()
    const selected = {
      hasSelection: !selection.isEmpty,
      startOffset: document.offsetAt(selection.start),
      endOffset: document.offsetAt(selection.end),
    }
    if (settings.sendText) selected.text = document.getText(selection)
    const result = {
      ownsFocus,
      editable: !document.isClosed,
      file: {
        name: path.basename(document.uri.fsPath),
        path: document.uri.fsPath,
        url: document.uri.toString(),
        writable: true,
        fileType: document.languageId,
        projectRelativePath: folder ? path.relative(folder.uri.fsPath, document.uri.fsPath).replace(/\\/g, '/') : undefined,
      },
      caret: {
        offset,
        line: selection.active.line,
        column: selection.active.character,
        lineNumber: selection.active.line + 1,
        columnNumber: selection.active.character + 1,
        visualLine: selection.active.line,
        visualColumn: selection.active.character,
      },
      selection: selected,
      carets: editor.selections.map((item, index) => ({
        primary: index === 0,
        offset: document.offsetAt(item.active),
        line: item.active.line,
        column: item.active.character,
        selectionStart: document.offsetAt(item.start),
        selectionEnd: document.offsetAt(item.end),
        ...(settings.sendText ? { selectedText: document.getText(item) } : {}),
      })),
    }
    if (folder) result.project = { projectId: projectId(folder.uri.fsPath), name: folder.name, basePath: folder.uri.fsPath }
    Object.assign(result, await this.editorContext(editor, offset))
    if (settings.sendText) {
      const radius = Math.max(0, settings.contextCharacters)
      const text = document.getText()
      const start = Math.max(0, offset - radius)
      const end = Math.min(text.length, offset + radius)
      result.textContext = { startOffset: start, endOffset: end, caretOffsetInText: offset - start, text: text.slice(start, end) }
    }
    return result
  }

  async editorContext(editor, offset) {
    const text = editor.document.getText()
    const syntaxContext = syntaxContextAt(text, offset, editor.document.languageId)
    const context = {
      context: syntaxContext,
    }
    const expression = extractExpression(text, offset)
    if (!expression || ['singleQuote', 'doubleQuote', 'backtick'].includes(syntaxContext)) return context

    const expressionContext = { expression, kind: 'reference' }
    try {
      const [hover, completion] = await Promise.all([
        vscode.commands.executeCommand('vscode.executeHoverProvider', editor.document.uri, editor.selection.active),
        vscode.commands.executeCommand('vscode.executeCompletionItemProvider', editor.document.uri, editor.selection.active),
      ])
      const info = hoverInfo(hover)
      if (info.kind) expressionContext.kind = info.kind
      if (info.type) expressionContext.type = info.type
      if (info.returnType) expressionContext.returnType = info.returnType
      const members = completionMembers(completion)
      if (members.length) expressionContext.members = members
    } catch (error) {
      // Language-service providers are optional. The generic expression still
      // remains useful when a language extension is unavailable or busy.
    }
    return { ...context, expressionContext }
  }

  async handle(raw) {
    let message
    try { message = JSON.parse(raw) } catch (error) {
      return this.send('command.result', this.error('unknown', 'INVALID_MESSAGE', error.message))
    }
    const type = message.type || ''
    const target = message.target || {}
    const mutating = ['command.navigate', 'command.select', 'command.find', 'command.deleteSelection', 'command.input', 'command.requestFocus', 'command.fullScreen', 'command.copyResourcePath', 'command.queryPythonPackages', 'command.ctrlW', 'command.ctrlShiftW', 'command.shiftHome', 'command.home', 'command.end', 'command.direction', 'command.inputTop', 'command.shiftDown', 'command.shiftUp', 'command.moveUpIfLastLine', 'command.executeIdeCommand'].includes(type)
    if (mutating && !target.instanceId) {
      return this.send('command.result', this.error(type, 'INVALID_MESSAGE', 'target.instanceId is required for this command'), message.id)
    }
    if (target.instanceId && target.instanceId !== this.instanceId) return
    try {
      let data
      if (type === 'command.ping') data = undefined
      else if (type === 'command.getState') data = await this.snapshot()
      else if (type === 'command.getInputable') data = await this.currentInputable()
      else if (type === 'command.getContext') data = await this.currentContext()
      else if (type === 'command.getObjectInfo') data = await this.currentObjectInfo()
      else if (type === 'command.getSelectedText') data = await this.currentSelectedText()
      else if (type === 'command.getCurrentLineContent') data = await this.currentLineContent()
      else if (type === 'command.isFullScreen') data = await this.isFullScreen()
      else if (type === 'command.listProjects') data = this.projects()
      else if (type === 'command.queryPythonPackages') data = await this.queryPythonPackages(message.payload || {}, target)
      else if (type === 'command.navigate' || type === 'command.select') data = await this.navigate(type, message.payload || {}, target)
      else if (type === 'command.find') data = await this.find(message.payload || {}, target)
      else if (type === 'command.deleteSelection') data = await this.deleteSelection(message.payload?.expectedText)
      else if (type === 'command.input') data = await this.input(message.payload?.text)
      else if (type === 'command.requestFocus') data = await this.requestFocus()
      else if (type === 'command.ctrlW') data = await this.ctrlW()
      else if (type === 'command.ctrlShiftW') data = await this.ctrlShiftW()
      else if (type === 'command.shiftHome') data = await this.shiftHome()
      else if (type === 'command.home') data = await this.home()
      else if (type === 'command.end') data = await this.end()
      else if (type === 'command.direction') data = await this.direction(message.payload || {})
      else if (type === 'command.inputTop') data = await this.inputTop(message.payload?.code)
      else if (type === 'command.shiftDown') data = await this.shiftDirection(message.payload || {}, 1)
      else if (type === 'command.shiftUp') data = await this.shiftDirection(message.payload || {}, -1)
      else if (type === 'command.moveUpIfLastLine') data = await this.moveUpIfLastLine()
      else if (type === 'command.executeIdeCommand') data = await this.executeIdeCommand(message.payload || {})
      else if (type === 'command.fullScreen') data = await this.fullScreen()
      else if (type === 'command.copyResourcePath') data = await this.copyResourcePath()
      else return this.send('command.result', this.error(type, 'UNKNOWN_COMMAND', `Unsupported command: ${type}`), message.id)
      this.send('command.result', { success: true, command: type, ...(data === undefined ? {} : { data }) }, message.id)
    } catch (error) {
      const fallback = type === 'command.navigate' || type === 'command.select' ? 'NAVIGATION_FAILED'
        : type === 'command.find' ? 'FIND_FAILED' : type === 'command.queryPythonPackages' ? 'PYTHON_QUERY_FAILED' : 'COMMAND_FAILED'
      this.send('command.result', this.error(type, error.code || fallback, error.message), message.id)
    }
  }

  error(command, code, message) {
    return { success: false, command: command || 'unknown', error: { code, message: message || 'Unknown error' } }
  }

  async queryPythonPackages(payload, target) {
    const requested = Array.isArray(payload.packages) ? payload.packages : []
    const packages = []
    for (const item of requested) {
      const importName = typeof item === 'string' ? item : item && item.importName
      const distributionName = typeof item === 'string' ? item : item && (item.distributionName || item.importName)
      if (!pythonPackageName.test(importName || '') || !pythonPackageName.test(distributionName || '') || packages.some(value => value.importName === importName)) continue
      packages.push({importName, distributionName})
    }
    if (!packages.length) throw Object.assign(new Error('payload.packages must contain at least one package name'), {code: 'INVALID_QUERY'})

    const folder = this.projectFolder(target, payload)
    const interpreter = await this.pythonInterpreter(folder)
    if (!interpreter) throw Object.assign(new Error('No Python interpreter is configured for the targeted workspace'), {code: 'PYTHON_INTERPRETER_NOT_FOUND'})
    const args = packages.map(item => `${item.importName}\t${item.distributionName}`)
    const result = await execFileAsync(interpreter, ['-c', pythonPackageQuery, ...args], {
      cwd: folder ? folder.uri.fsPath : undefined,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    try {
      const value = JSON.parse(result.stdout.trim())
      if (!value || typeof value !== 'object' || !value.packages) throw new Error('Python interpreter returned invalid JSON')
      return value
    } catch (error) {
      throw Object.assign(new Error('Python interpreter returned invalid package data'), {code: 'PYTHON_QUERY_FAILED'})
    }
  }

  projectFolder(target, payload) {
    const requestedBase = payload.projectBasePath || target.projectBasePath
    return (vscode.workspace.workspaceFolders || []).find(folder => {
      if (requestedBase && path.resolve(folder.uri.fsPath).toLowerCase() !== path.resolve(requestedBase).toLowerCase()) return false
      return !target.projectId || projectId(folder.uri.fsPath) === target.projectId
    }) || (vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)) || null
  }

  async pythonInterpreter(folder) {
    try {
      const selected = await vscode.commands.executeCommand('python.interpreterPath')
      if (typeof selected === 'string' && selected.trim()) return selected
    } catch (error) {
      // The Python extension is optional.
    }
    const configuration = vscode.workspace.getConfiguration('python', folder && folder.uri)
    const configured = configuration.get('defaultInterpreterPath') || configuration.get('pythonPath')
    if (typeof configured !== 'string' || !configured.trim()) return null
    return path.isAbsolute(configured) || !folder ? configured : path.resolve(folder.uri.fsPath, configured)
  }

  openDocumentUri(requested) {
    let requestedUri
    try {
      if (typeof requested !== 'string') return null
      if (/^file:/i.test(requested)) requestedUri = vscode.Uri.parse(requested)
      else if (path.isAbsolute(requested)) requestedUri = vscode.Uri.file(path.resolve(requested))
      else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(requested)) requestedUri = vscode.Uri.parse(requested)
      else return null
    } catch (error) {
      return null
    }
    return (vscode.workspace.textDocuments || []).find(document => {
      if (requestedUri.scheme === 'file' && document.uri.scheme === 'file') {
        return path.resolve(document.uri.fsPath).toLowerCase() === path.resolve(requestedUri.fsPath).toLowerCase()
      }
      return document.uri.toString() === requestedUri.toString()
    })?.uri || null
  }

  isLocalRuntimeDependency(basePath, candidate) {
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(basePath, 'package.json'), 'utf8')).dependencies?.['fastjs-runtime']
      return typeof runtime === 'string' && runtime.startsWith('file:') &&
        path.resolve(candidate).toLowerCase().startsWith((fs.realpathSync.native(path.resolve(basePath, runtime.slice(5))) + path.sep).toLowerCase())
    } catch (error) {
      return false
    }
  }

  resolveUri(requested, payload, target, allowActive) {
    if (!requested && allowActive && vscode.window.activeTextEditor) return vscode.window.activeTextEditor.document.uri
    if (!requested) throw new Error('payload.path is required')
    const requestedBase = payload.projectBasePath || target.projectBasePath
    const candidates = this.projects().filter(item => (!target.projectId || item.projectId === target.projectId) &&
      (!requestedBase || path.resolve(item.basePath).toLowerCase() === path.resolve(requestedBase).toLowerCase()))
    const requestedUri = /^file:/i.test(requested) ? vscode.Uri.parse(requested) : null
    const requestedPath = requestedUri?.scheme === 'file' ? path.resolve(requestedUri.fsPath) : path.isAbsolute(requested) ? path.resolve(requested) : ''
    if(requestedPath && candidates.some(item => this.isLocalRuntimeDependency(item.basePath, requestedPath))) {
      return vscode.Uri.file(requestedPath)
    }
    if (allowActive && requestedUri) {
      const project = requestedPath && candidates.find(item => {
        const base = path.resolve(item.basePath)
        return requestedPath === base || requestedPath.toLowerCase().startsWith((base + path.sep).toLowerCase())
      })
      if (project) return vscode.Uri.file(requestedPath)
    }
    if (requestedUri) {
      if (allowActive && (!target.projectId && !requestedBase || candidates.length > 0)) {
        const openUri = this.openDocumentUri(requested)
        if (openUri) return openUri
        throw new Error('File URI was not found in an open text document')
      }
      return requestedUri
    }
    const project = candidates.find(item => {
      const base = path.resolve(item.basePath)
      const candidate = path.resolve(base, requested)
      return candidate === base || candidate.toLowerCase().startsWith((base + path.sep).toLowerCase())
    })
    if (!project && allowActive && (!target.projectId && !requestedBase || candidates.length > 0)) {
      const openUri = this.openDocumentUri(requested)
      if (openUri) return openUri
    }
    if (!project) throw new Error('File was not found inside an open project')
    const resolved = path.resolve(project.basePath, requested)
    return vscode.Uri.file(resolved)
  }

  async openEditor(payload, target, allowActive = false) {
    const document = await vscode.workspace.openTextDocument(this.resolveUri(payload.path, payload, target, allowActive))
    return vscode.window.showTextDocument(document, { preview: false })
  }

  position(document, value, base) {
    const line = Math.min(Math.max(0, value.line - base), Math.max(0, document.lineCount - 1))
    const column = Math.min(Math.max(0, value.column - base), document.lineAt(line).text.length)
    return new vscode.Position(line, column)
  }

  async navigate(type, payload, target) {
    const editor = await this.openEditor(payload, target)
    const base = Number.isInteger(payload.coordinateBase) ? payload.coordinateBase : 0
    if (type === 'command.select') {
      if (!payload.start || !payload.end) throw new Error('Selection start/end is required')
      editor.selection = new vscode.Selection(
        this.position(editor.document, payload.start, base),
        this.position(editor.document, payload.end, base),
      )
    } else {
      const active = editor.selection.active
      const line = payload.line == null ? active.line
        : Math.min(Math.max(0, payload.line - base), Math.max(0, editor.document.lineCount - 1))
      const column = payload.column == null ? active.character
        : Math.min(Math.max(0, payload.column - base), editor.document.lineAt(line).text.length)
      editor.selection = new vscode.Selection(line, column, line, column)
    }
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenter)
    return { path: editor.document.uri.fsPath, line: editor.selection.active.line, column: editor.selection.active.character }
  }

  async find(payload, target) {
    if (!payload.query) throw Object.assign(new Error('payload.query is required'), { code: 'INVALID_QUERY' })
    const document = await vscode.workspace.openTextDocument(this.resolveUri(payload.path, payload, target, true))
    let editor = vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()
      ? vscode.window.activeTextEditor
      : await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false })
    const text = editor.document.getText()
    const from = Math.max(0, Math.min(payload.startOffset || 0, text.length))
    let start = -1
    let end = -1
    if (payload.regex) {
      let expression
      try { expression = new RegExp(payload.query, payload.caseSensitive ? '' : 'i') }
      catch (error) { throw Object.assign(error, { code: 'INVALID_QUERY' }) }
      const match = expression.exec(text.slice(from))
      if (match) { start = from + match.index; end = start + match[0].length }
    } else {
      const source = payload.caseSensitive ? text : text.toLocaleLowerCase()
      const query = payload.caseSensitive ? payload.query : payload.query.toLocaleLowerCase()
      start = source.indexOf(query, from)
      if (start >= 0) end = start + payload.query.length
    }
    if (start < 0) throw Object.assign(new Error('No match found'), { code: 'NOT_FOUND' })
    const first = editor.document.positionAt(start)
    const last = editor.document.positionAt(end)
    const targetRange = new vscode.Range(first, last)
    const targetSelection = payload.select ? new vscode.Selection(first, last) : new vscode.Selection(first, first)
    const applyTarget = currentEditor => {
      currentEditor.selection = targetSelection
      currentEditor.revealRange(targetRange, vscode.TextEditorRevealType.InCenter)
    }
    applyTarget(editor)
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')

    const samePosition = (left, right) => left && right && left.line === right.line && left.character === right.character
    const sameDocument = candidate => candidate && candidate.document.uri.toString() === document.uri.toString()
    const selectionApplied = candidate => candidate && samePosition(candidate.selection.start, targetSelection.start) &&
      samePosition(candidate.selection.end, targetSelection.end)
    const rangeVisible = candidate => {
      if (!Array.isArray(candidate?.visibleRanges)) return undefined
      const compare = (left, right) => left.line - right.line || left.character - right.character
      return candidate.visibleRanges.some(visible => compare(visible.end, targetRange.start) >= 0 &&
        compare(targetRange.end, visible.start) >= 0)
    }
    const verifyTarget = async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      const activeEditor = vscode.window.activeTextEditor
      const editorTextFocus = await this.contextKeyValue('editorTextFocus')
      return {
        activeEditor,
        activeDocument: sameDocument(activeEditor),
        selection: selectionApplied(activeEditor),
        visible: rangeVisible(activeEditor),
        textFocus: contextKeyIsKnown(editorTextFocus) ? contextKeyIsTrue(editorTextFocus) : undefined,
      }
    }

    let verification = await verifyTarget()
    if (!verification.activeDocument || !verification.selection || verification.visible === false || verification.textFocus === false) {
      editor = await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, preview: false, preserveFocus: false })
      applyTarget(editor)
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
      verification = await verifyTarget()
    }
    if (!verification.activeDocument || !verification.selection || verification.visible === false || verification.textFocus === false) {
      throw Object.assign(new Error('Find target was not activated, selected, or revealed'), { code: 'FIND_NOT_VISIBLE' })
    }
    return {
      path: editor.document.uri.fsPath,
      startOffset: start,
      endOffset: end,
      line: first.line,
      column: first.character,
      lineNumber: first.line + 1,
      columnNumber: first.character + 1,
      caseSensitive: !!payload.caseSensitive,
      regex: !!payload.regex,
      selected: !!payload.select,
    }
  }

  async requestFocus() {
    const editor = vscode.window.activeTextEditor
    if (!editor) throw Object.assign(new Error('No active text editor'), { code: 'NO_EDITOR' })
    await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false })
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
    return { project: folder ? folder.name : '' }
  }
  async ctrlW() {
    await this.requestFocus()
    const before = vscode.window.activeTextEditor.selections
    await vscode.commands.executeCommand('editor.action.smartSelect.expand')
    return {handled: vscode.window.activeTextEditor.selections.some((selection, index) => !selection.isEqual(before[index]))}
  }

  async ctrlShiftW() {
    await this.requestFocus()
    const before = vscode.window.activeTextEditor.selections
    await vscode.commands.executeCommand('editor.action.smartSelect.shrink')
    return {handled: vscode.window.activeTextEditor.selections.some((selection, index) => !selection.isEqual(before[index]))}
  }


  async shiftHome() {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      throw Object.assign(new Error('No active text editor'), {code: 'NO_EDITOR'})
    }
    let handled = false
    editor.selections = editor.selections.map(selection => {
      // Preserve a selection whose active end is already at the line start.
      // Recreating it would collapse the selection on a repeated Shift+Home.
      if (selection.active.character === 0) return selection
      handled = true
      return new vscode.Selection(selection.active, new vscode.Position(selection.active.line, 0))
    })
    return {handled}
  }

  async home() {
    const editor = vscode.window.activeTextEditor
    if (!editor) throw Object.assign(new Error('No active text editor'), {code: 'NO_EDITOR'})
    editor.selections = editor.selections.map(selection => {
      const position = new vscode.Position(selection.active.line, 0)
      return new vscode.Selection(position, position)
    })
    return {handled: true}
  }

  async end() {
    const editor = vscode.window.activeTextEditor
    if (!editor) throw Object.assign(new Error('No active text editor'), {code: 'NO_EDITOR'})
    editor.selections = editor.selections.map(selection => {
      const position = new vscode.Position(selection.active.line, editor.document.lineAt(selection.active.line).text.length)
      return new vscode.Selection(position, position)
    })
    return {handled: true}
  }

  async direction({command, count = 1}) {
    const moves = {
      left: {to: 'left', select: false},
      right: {to: 'right', select: false},
      'shift left': {to: 'left', select: true},
      'shift right': {to: 'right', select: true},
      'ctrl shift left': {to: 'left', select: true},
      'ctrl shift right': {to: 'right', select: true},
      'shift end': {to: 'wrappedLineEnd', select: true},
    }
    const move = moves[command]
    if (!move) throw Object.assign(new Error('Unsupported direction command'), {code: 'INVALID_MESSAGE'})
    await vscode.commands.executeCommand('cursorMove', {...move, by: command.includes('ctrl') ? 'word' : 'character', value: Math.max(1, Number.isInteger(count) ? count : 1)})
    return {handled: true}
  }

  async inputTop(code) {
    const editor = vscode.window.activeTextEditor
    if (!editor) throw Object.assign(new Error('No active text editor'), {code: 'NO_EDITOR'})
    if (typeof code !== 'string' || !code) throw Object.assign(new Error('payload.code is required'), {code: 'INVALID_MESSAGE'})
    const lineEnding = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'
    const text = editor.document.getText()
    const offset = inputTopOffset(text, /^(python|cython)$/.test(editor.document.languageId || ''))
    const position = editor.document.positionAt(offset)
    const prefix = offset > 0 && !/[\r\n]$/.test(text[offset - 1]) ? lineEnding : ''
    if (!await editor.edit(edit => edit.insert(position, prefix + code + lineEnding))) throw new Error('Unable to insert text at document start')
    return {handled: true}
  }

  async shiftDirection({count = 1}, direction) {
    const editor = vscode.window.activeTextEditor
    if (!editor) throw Object.assign(new Error('No active text editor'), {code: 'NO_EDITOR'})
    count = Math.max(1, Number.isInteger(count) ? count : 1)
    await vscode.commands.executeCommand('cursorMove', {to: direction > 0 ? 'down' : 'up', by: 'line', value: count, select: true})
    return {handled: true}
  }

  async moveUpIfLastLine() {
    const editor = vscode.window.activeTextEditor
    if (!editor) throw Object.assign(new Error('No active text editor'), {code: 'NO_EDITOR'})
    const active = editor.selection.active
    if (active.line === 0) return {handled: false}
    for (let index = active.line + 1; index < editor.document.lineCount; index++) {
      if (editor.document.lineAt(index).text.trim()) return {handled: false}
    }
    const line = active.line - 1
    const column = Math.min(active.character, editor.document.lineAt(line).text.length)
    editor.selection = new vscode.Selection(line, column, line, column)
    return {handled: true}
  }

  async isFullScreen() {
    const value = await this.contextKeyValue('isFullscreen')
    return {fullScreen: value === undefined || value === null ? null : value === true || value === 'true'}
  }

  async fullScreen() {
    await vscode.commands.executeCommand('workbench.action.toggleFullScreen')
    await new Promise(resolve => setTimeout(resolve, 80))
    return this.isFullScreen()
  }

  async contextKeyValue(key) {
    try {
      return await vscode.commands.executeCommand('getContextKeyValue', key)
    } catch (error) {
      return undefined
    }
  }

  async copyResourcePath(assumeFilesExplorerFocus = false) {
    const activeResourcePath = this.contextResourcePath(
      await this.contextKeyValue('resource')
    )
    let explorerFocused = assumeFilesExplorerFocus
    if (!assumeFilesExplorerFocus) {
      const [explorerFocus, explorerViewletFocus, sideBarFocus, activeViewlet,
        isFileSystemResource] =
        await Promise.all([
          this.contextKeyValue('filesExplorerFocus'),
          this.contextKeyValue('explorerViewletFocus'),
          this.contextKeyValue('sideBarFocus'),
          this.contextKeyValue('activeViewlet'),
          this.contextKeyValue('isFileSystemResource'),
        ])
      const isTrue = value => value === true || value === 'true'
      const hasValue = value => value !== undefined && value !== null
      explorerFocused = isTrue(explorerFocus) || isTrue(explorerViewletFocus) ||
        isTrue(sideBarFocus) && activeViewlet === 'workbench.view.explorer'
      const focusContextKnown = [explorerFocus, explorerViewletFocus, sideBarFocus, activeViewlet]
        .some(hasValue)
      if (focusContextKnown && !explorerFocused) {
        // Image and other custom editors do not have activeTextEditor, but
        // their selected resource is still the active `resource`. Support the
        // requested current-resource fallback for those editors only.
        if (!vscode.window.activeTextEditor && activeResourcePath &&
          await this.isRegularFilePath(activeResourcePath)) {
          return this.resourcePathResult([activeResourcePath])
        }
        return {handled: false}
      }
      if (isFileSystemResource === false || isFileSystemResource === 'false') {
        return {handled: false}
      }
    }

    // `resource` is the active editor resource, not necessarily the focused
    // Explorer row. Ask VS Code's built-in Explorer command for the focused
    // row instead of trying to infer it from that context key.
    const commands = ['copyFilePath']
    const available = await vscode.commands.getCommands(true)
    for (const command of commands) {
      if (!available.includes(command)) continue
      let previousClipboard = ''
      let copiedPath = ''
      try {
        previousClipboard = await vscode.env.clipboard.readText()
        // Prevent an old path from being mistaken for the result when the
        // built-in command does not update the clipboard for a resource.
        await vscode.env.clipboard.writeText('')
        await vscode.commands.executeCommand(command)
        const copiedPaths = (await vscode.env.clipboard.readText())
          .split(/\r?\n/)
          .map(value => this.contextResourcePath(value))
          .filter(Boolean)
        const existingPaths = []
        for (const candidate of copiedPaths) {
          if (await this.isExistingResourcePath(candidate)) existingPaths.push(candidate)
        }
        copiedPath = existingPaths[0] || ''
        if (existingPaths.length > 0) {
          return this.resourcePathResult(existingPaths)
        }
      } catch (error) {
        // Preserve the existing Fast Ctrl+Shift+C behavior when the command
        // is unavailable or cannot resolve the focused Explorer row.
      } finally {
        if (!copiedPath && previousClipboard) {
          try {
            await vscode.env.clipboard.writeText(previousClipboard)
          } catch (error) {
            // Ignore clipboard restoration failures.
          }
        }
      }
    }

    // Some VS Code resource editors (notably image previews) do not expose
    // their Explorer row to extensions. In that case use the active editor
    // resource, which is the selected file after it has been opened.
    if (activeResourcePath &&
      ((explorerFocused && await this.isExistingResourcePath(activeResourcePath)) ||
        await this.isRegularFilePath(activeResourcePath))) {
      return this.resourcePathResult([activeResourcePath])
    }
    return {handled: false}
  }

  resourcePathResult(paths) {
    const uniquePaths = [...new Set(paths)]
    return uniquePaths.length === 1
      ? {handled: true, path: uniquePaths[0], paths: uniquePaths}
      : {handled: true, paths: uniquePaths}
  }

  contextResourcePath(value) {
    if (typeof value !== 'string' || !value.trim()) return ''
    const text = value.trim()
    try {
      if (/^file:/i.test(text)) return path.normalize(vscode.Uri.parse(text).fsPath)
    } catch (error) {
      return ''
    }
    return path.isAbsolute(text) ? path.normalize(text) : ''
  }

  async isRegularFilePath(resourcePath) {
    return (await this.resourceType(resourcePath) & vscode.FileType.File) !== 0
  }

  async isExistingResourcePath(resourcePath) {
    const type = await this.resourceType(resourcePath)
    return (type & (vscode.FileType.File | vscode.FileType.Directory)) !== 0
  }

  async resourceType(resourcePath) {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(resourcePath))
      return stat.type
    } catch (error) {
      return vscode.FileType.Unknown
    }
  }

  log(text, level = 'info') {
    const message = compactLogText(text)
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`
    const outputMethod = this.output && typeof this.output[level] === 'function' ? this.output[level] : null
    if (outputMethod) outputMethod.call(this.output, message)
    else this.output.appendLine(line)
    this.writeLog(line)
  }

  writeLog(line) {
    if (!this.logDirectory) return
    try {
      fs.mkdirSync(this.logDirectory, { recursive: true })
      const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000
      for (const name of fs.readdirSync(this.logDirectory)) {
        if (!/^fast-vscode-bridge-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?$/.test(name)) continue
        const file = path.join(this.logDirectory, name)
        try {
          if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
        } catch (error) {
          // Ignore a file that disappeared or is locked while pruning.
        }
      }
      const name = `fast-vscode-bridge-${new Date().toISOString().slice(0, 10)}.log`
      const file = path.join(this.logDirectory, name)
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line, 'utf8') + 1 > maxLogFileBytes) {
        const oldest = `${file}.${logBackupCount}`
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest)
        for (let index = logBackupCount - 1; index >= 1; index--) {
          const source = `${file}.${index}`
          if (fs.existsSync(source)) fs.renameSync(source, `${file}.${index + 1}`)
        }
        fs.renameSync(file, `${file}.1`)
      }
      fs.appendFileSync(file, `${line}\n`, 'utf8')
    } catch (error) {
      // The host LogOutputChannel remains the fallback when the file cannot be written.
    }
  }

  dispose() {
    this.log('service disposed')
    this.disposed = true
    this.generation++
    clearTimeout(this.pending)
    clearTimeout(this.pendingStatus)
    this.stopFocusPolling()
    if (this.socket) this.socket.close(1000, 'plugin disposed')
    this.socket = null
  }
}

module.exports = { FastBridge, projectId }
