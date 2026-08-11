const vscode = require('vscode')
const crypto = require('crypto')
const path = require('path')
const WebSocket = require('ws')

const uuid = () => crypto.randomUUID()

function projectId(basePath) {
  const bytes = crypto.createHash('md5').update(path.resolve(basePath || '').toLowerCase()).digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const value = bytes.toString('hex')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

class FastBridge {
  constructor(context) {
    this.context = context
    this.instanceId = uuid()
    this.connectionId = uuid()
    this.sequence = 0
    this.generation = 0
    this.reconnectAttempt = 0
    this.output = vscode.window.createOutputChannel('Fast Bridge')
  }

  async start() {
    this.installationId = this.context.globalState.get('fastBridge.installationId') || uuid()
    await this.context.globalState.update('fastBridge.installationId', this.installationId)
    this.context.subscriptions.push(
      this.output,
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule('focus.changed', 0)),
      vscode.window.onDidChangeTextEditorSelection(() => this.schedule('editor.caretChanged', 40)),
      vscode.workspace.onDidChangeTextDocument(() => this.schedule('editor.documentChanged', 100)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reconnect()),
      vscode.workspace.onDidChangeConfiguration(event => event.affectsConfiguration('fastBridge') && this.reconnect()),
      vscode.commands.registerCommand('fastBridge.reconnect', () => this.reconnect()),
      vscode.commands.registerCommand('fastBridge.showOutput', () => this.output.show()),
      { dispose: () => this.dispose() },
    )
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
      this.log(`连接配置无效：${error.message}`)
      return
    }
    socket.on('open', () => {
      if (generation !== this.generation || this.disposed) return socket.close()
      this.socket = socket
      this.connectionId = uuid()
      this.reconnectAttempt = 0
      this.log('已连接')
      this.send('bridge.hello', this.identity())
      this.schedule('editor.state', 0)
    })
    socket.on('message', data => {
      if (data.length > 1024 * 1024) return socket.close(1009, 'message too large')
      this.handle(data.toString()).catch(error => this.log(error.stack || error.message))
    })
    socket.on('error', error => this.log(`连接错误：${error.message}`))
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
      if (this.disposed || generation !== this.generation || !this.settings().autoConnect) return
      const delays = [200, 500, 1000, 2000]
      setTimeout(() => generation === this.generation && this.connect(), delays[Math.min(this.reconnectAttempt++, 3)])
    })
  }

  identity() {
    return {
      client: 'fast-vscode-bridge',
      clientId: this.installationId,
      installationId: this.installationId,
      instanceId: this.instanceId,
      connectionId: this.connectionId,
      ide: vscode.env.appName,
      build: vscode.version,
      pluginVersion: this.context.extension.packageJSON.version,
      projects: this.projects(),
      processId: process.pid,
      nativeWindows: { supported: false, windows: [] },
      capabilities: ['state', 'navigate', 'select', 'find', 'requestFocus', 'listProjects'],
    }
  }

  send(type, payload, replyTo) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    const source = {
      installationId: this.installationId,
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
    this.socket.send(JSON.stringify(message))
  }

  schedule(type, delay) {
    clearTimeout(this.pending)
    this.pending = setTimeout(() => this.send(type, this.snapshot()), delay)
  }

  snapshot() {
    const editor = vscode.window.activeTextEditor
    return {
      focus: editor ? { type: 'editor', className: 'vscode.TextEditor', enabled: true, visible: true, showing: true } : { type: 'none' },
      activeEditor: editor ? this.describe(editor) : null,
    }
  }

  describe(editor) {
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
      ownsFocus: true,
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
    if (settings.sendText) {
      const radius = Math.max(0, settings.contextCharacters)
      const text = document.getText()
      const start = Math.max(0, offset - radius)
      const end = Math.min(text.length, offset + radius)
      result.textContext = { startOffset: start, endOffset: end, caretOffsetInText: offset - start, text: text.slice(start, end) }
    }
    return result
  }

  async handle(raw) {
    let message
    try { message = JSON.parse(raw) } catch (error) {
      return this.send('command.result', this.error('unknown', 'INVALID_MESSAGE', error.message))
    }
    const type = message.type || ''
    const target = message.target || {}
    const mutating = ['command.navigate', 'command.select', 'command.find', 'command.requestFocus'].includes(type)
    if (mutating && !target.instanceId) {
      return this.send('command.result', this.error(type, 'INVALID_MESSAGE', 'target.instanceId is required for this command'), message.id)
    }
    if (target.instanceId && target.instanceId !== this.instanceId) return
    try {
      let data
      if (type === 'command.ping') data = undefined
      else if (type === 'command.getState') data = this.snapshot()
      else if (type === 'command.listProjects') data = this.projects()
      else if (type === 'command.navigate' || type === 'command.select') data = await this.navigate(type, message.payload || {}, target)
      else if (type === 'command.find') data = await this.find(message.payload || {}, target)
      else if (type === 'command.requestFocus') data = await this.requestFocus()
      else return this.send('command.result', this.error(type, 'UNKNOWN_COMMAND', `Unsupported command: ${type}`), message.id)
      this.send('command.result', { success: true, command: type, ...(data === undefined ? {} : { data }) }, message.id)
    } catch (error) {
      const fallback = type === 'command.navigate' || type === 'command.select' ? 'NAVIGATION_FAILED'
        : type === 'command.find' ? 'FIND_FAILED' : 'COMMAND_FAILED'
      this.send('command.result', this.error(type, error.code || fallback, error.message), message.id)
    }
  }

  error(command, code, message) {
    return { success: false, command: command || 'unknown', error: { code, message: message || 'Unknown error' } }
  }

  resolveUri(requested, payload, target, allowActive) {
    if (!requested && allowActive && vscode.window.activeTextEditor) return vscode.window.activeTextEditor.document.uri
    if (!requested) throw new Error('payload.path is required')
    if (/^file:/i.test(requested)) return vscode.Uri.parse(requested)
    const requestedBase = payload.projectBasePath || target.projectBasePath
    const candidates = this.projects().filter(item => (!target.projectId || item.projectId === target.projectId) &&
      (!requestedBase || path.resolve(item.basePath).toLowerCase() === path.resolve(requestedBase).toLowerCase()))
    const project = candidates.find(item => {
      const base = path.resolve(item.basePath)
      const candidate = path.resolve(base, requested)
      return candidate === base || candidate.toLowerCase().startsWith((base + path.sep).toLowerCase())
    })
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
    } else if (payload.line != null || payload.column != null) {
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
    const editor = await this.openEditor(payload, target, true)
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
    editor.selection = payload.select ? new vscode.Selection(first, last) : new vscode.Selection(first, first)
    editor.revealRange(new vscode.Range(first, last), vscode.TextEditorRevealType.InCenter)
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

  log(text) {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${text}`)
  }

  dispose() {
    this.disposed = true
    this.generation++
    clearTimeout(this.pending)
    if (this.socket) this.socket.close(1000, 'plugin disposed')
    this.socket = null
  }
}

module.exports = { FastBridge, projectId }
