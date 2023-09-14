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


function handleIndent(text) {
  text = indentBefore(text)
  return indent(text)
}


function activate(context) {
  var disposable = vscode.commands.registerCommand('extension.beautifyScs', function () {
    var selections = []

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
        text = _.replace(text, /\n\s*\n/g, '\n')
        text = _.replace(text, /\n(\/\/\s*-{10,}.*)/g, '\n\n$1')
        text = _.replace(text, /[\n\r]{3,}(?=\/\/\/)/g, '')
        text = _.replace(text, /(?<!^)\s*\/\/\//g, '\n\n\/\/\/')
        text = handleIndent(text)
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

