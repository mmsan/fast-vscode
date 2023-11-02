// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
var vscode = require('vscode')
const _ = require('lodash')


function indentBefore(text, deep = 0, isWhile = true) {
  let has = false
  let pattern = /(?<=(\r?\n|^)\s*)\{([\d&|!()]*\?|!)\s*\r?\n[\s\S]+?\r?\n\s*\}(?=\s*(\r?\n|$))/g
  text = _.replace(text, pattern, v => {
    let v_ = v.substring(1)
    has = true

    if (/(?<=(\r?\n|^))\s*\{([\d&|!()]*\?|!)\s*\r?\n/g.test(v_)) {
      return v[0] + indentBefore(v_, deep + 1, false)
    }

    let s = `__indent${deep}__`
    return s + v + s
  })

  if (has && isWhile) {
    return indentBefore(text)
  }

  // text = _.replace(text, /__indent0__/g, '')
  return text
}


function indent(text) {
  let has = false
  text = _.replace(text, / *(?<indent>__indent\d+__)[\s\S]+?\k<indent>/g, (match, indentStr) => {
    has = true
    let n = parseInt(_.first(indentStr.match(/\d+/g)))
    match = _.replace(match, /(\r?\n|^) */g, '$1' + _.repeat('  ', n + 1))
    match = _.replace(match, new RegExp(` *${indentStr}\\{`, 'g'), _.repeat('  ', n) + '{')
    match = _.replace(match, new RegExp(` *\\}${indentStr}`, 'g'), _.repeat('  ', n) + '}')
    return match

  })

  if (has) {
    return indent(text)
  }

  return text
}

function replaceBigBrace(text) {
  let has = false
  text = _.replace(text, /\{.*?\}/g, v => {
    has = true
    let [r, has_] = replaceBigBrace(v.substring(1))

    if (has_) {
      return v[0] + r
    }

    return `__big_left__${v.substring(1, _.size(v) - 1)}__big_right__`
  })


  if (has) {
    text = replaceBigBrace(text)[0]
  }

  return [text, has]
}


function handleIndent(text) {
  text = _.replace(text, /.*[}]+ *\r?\n/g, v => {
    v = replaceBigBrace(v)[0]
    v = _.trimEnd(v)
    v = _.replace(v, /.*}+$/g, v => {
      if (/\S/g.test(_.replace(v, /}+$/g, ''))) {
        v = _.replace(v, /}+$/g, v => {
          return '\n' + _.join(v, '\n')
        })
      } else {
        v = _.replace(v, /}+$/g, v => {
          if (_.size(v) > 1) {
            return _.join(v, '\n')
          }
          return v
        })
      }
      return v
    })
    v = _.replace(v, /__big_left__/g, '{')
    v = _.replace(v, /__big_right__/g, '}')
    return v + '\n'
  })
  text = indentBefore(text)
  return indent(text)
}


function activate(context) {
  var disposable = vscode.commands.registerCommand('extension.beautifyScs', function () {
    var selections = []
    let a=1
    for (var i = 0; i < vscode.window.activeTextEditor.selections.length; i++) {
      var s = vscode.window.activeTextEditor.selections[i]
      if (!s.start.isEqual(s.end))
        selections.push(new vscode.Range(s.start, s.end))
    }

    if (selections.length === 0) {
      selections.push(new vscode.Range(vscode.window.activeTextEditor.document.positionAt(0), vscode.window.activeTextEditor.document.positionAt(vscode.window.activeTextEditor.document.getText().length)))
    }
    vscode.window.activeTextEditor.edit(function (builder) {
      for (var i = 0; i < selections.length; i++) {
        var range = selections[i]
        var text = vscode.window.activeTextEditor.document.getText(range).toString()
        // text = handleIndent(text)
        // text = _.replace(text, /\n\s*\n/g, '\n')
        // text = _.replace(text, /\n(\/\/\s*-{10,}.*)/g, '\n\n$1')
        // text = _.replace(text, /[\n\r]{3,}(?=\/\/\/)/g, ''
        // text = _.replace(text, /(?<!^)\s*\/\/\//g, '\n\n\/\/\/')
        text = _.replace(text, /(\r?\n|^)\s*\/\/\/\s*[\s\S]+?(?=(\r?\n\s*\/\/\/|$))/g, v => {
          let isStart = !/^\r?\n/g.test(v)
          v = _.trim(v)
          v = handleIndent(v)
          v = _.replace(v, /\n\s*\n/g, '\n')
          v = _.replace(v, /\n(\/\/\s*-{10,}.*)/g, '\n\n$1')
          let isEmpty = !_.includes(_.trimEnd(v), '\n')
          return (isStart ? '' : '\n') + v + (isEmpty ? '' : '\n')
        })
        builder.replace(range, text)
      }
    })
  })
  context.subscriptions.push(disposable)
}

exports.activate = activate

// this method is called when your extension is deactivated
function deactivate() {
}

exports.deactivate = deactivate

