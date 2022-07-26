// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
var vscode = require('vscode')
const _ = require('lodash')

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

