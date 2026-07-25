
using namespace System.Management.Automation
using namespace System.Management.Automation.Language

Register-ArgumentCompleter -Native -CommandName 'whetstone-tui' -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commandElements = $commandAst.CommandElements
    $command = @(
        'whetstone-tui'
        for ($i = 1; $i -lt $commandElements.Count; $i++) {
            $element = $commandElements[$i]
            if ($element -isnot [StringConstantExpressionAst] -or
                $element.StringConstantType -ne [StringConstantType]::BareWord -or
                $element.Value.StartsWith('-') -or
                $element.Value -eq $wordToComplete) {
                break
        }
        $element.Value
    }) -join ';'

    $completions = @(switch ($command) {
        'whetstone-tui' {
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('-V', '-V ', [CompletionResultType]::ParameterName, 'Print version')
            [CompletionResult]::new('--version', '--version', [CompletionResultType]::ParameterName, 'Print version')
            [CompletionResult]::new('open', 'open', [CompletionResultType]::ParameterValue, 'Open the editor (same as passing a bare file path)')
            [CompletionResult]::new('lint', 'lint', [CompletionResultType]::ParameterValue, 'Lint a file with Harper; prints diagnostics as JSON')
            [CompletionResult]::new('coach', 'coach', [CompletionResultType]::ParameterValue, 'Run one coach turn over a file, screened by the guard (+ judge if set)')
            [CompletionResult]::new('guard', 'guard', [CompletionResultType]::ParameterValue, 'Screen an arbitrary reply with the deterministic guard (+ judge if set)')
            [CompletionResult]::new('ownership', 'ownership', [CompletionResultType]::ParameterValue, 'Claim-to-own survival of an original paste within the current text')
            [CompletionResult]::new('disclosure', 'disclosure', [CompletionResultType]::ParameterValue, 'Render a disclosure document from a journal (a JSON array of events)')
            [CompletionResult]::new('export', 'export', [CompletionResultType]::ParameterValue, 'Export a `.qmd` / `.md` document as HTML or plain text (no Quarto needed)')
            [CompletionResult]::new('words', 'words', [CompletionResultType]::ParameterValue, 'Word/character/line counts for a document (JSON)')
            [CompletionResult]::new('help', 'help', [CompletionResultType]::ParameterValue, 'Print this message or the help of the given subcommand(s)')
            break
        }
        'whetstone-tui;open' {
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;lint' {
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;coach' {
            [CompletionResult]::new('--message', '--message', [CompletionResultType]::ParameterName, 'message')
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;guard' {
            [CompletionResult]::new('--reply', '--reply', [CompletionResultType]::ParameterName, 'reply')
            [CompletionResult]::new('--draft', '--draft', [CompletionResultType]::ParameterName, 'draft')
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;ownership' {
            [CompletionResult]::new('--original', '--original', [CompletionResultType]::ParameterName, 'original')
            [CompletionResult]::new('--current', '--current', [CompletionResultType]::ParameterName, 'current')
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;disclosure' {
            [CompletionResult]::new('--journal', '--journal', [CompletionResultType]::ParameterName, 'journal')
            [CompletionResult]::new('--doc-id', '--doc-id', [CompletionResultType]::ParameterName, 'doc-id')
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;export' {
            [CompletionResult]::new('--format', '--format', [CompletionResultType]::ParameterName, 'format')
            [CompletionResult]::new('--out', '--out', [CompletionResultType]::ParameterName, 'out')
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;words' {
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;help' {
            [CompletionResult]::new('open', 'open', [CompletionResultType]::ParameterValue, 'Open the editor (same as passing a bare file path)')
            [CompletionResult]::new('lint', 'lint', [CompletionResultType]::ParameterValue, 'Lint a file with Harper; prints diagnostics as JSON')
            [CompletionResult]::new('coach', 'coach', [CompletionResultType]::ParameterValue, 'Run one coach turn over a file, screened by the guard (+ judge if set)')
            [CompletionResult]::new('guard', 'guard', [CompletionResultType]::ParameterValue, 'Screen an arbitrary reply with the deterministic guard (+ judge if set)')
            [CompletionResult]::new('ownership', 'ownership', [CompletionResultType]::ParameterValue, 'Claim-to-own survival of an original paste within the current text')
            [CompletionResult]::new('disclosure', 'disclosure', [CompletionResultType]::ParameterValue, 'Render a disclosure document from a journal (a JSON array of events)')
            [CompletionResult]::new('export', 'export', [CompletionResultType]::ParameterValue, 'Export a `.qmd` / `.md` document as HTML or plain text (no Quarto needed)')
            [CompletionResult]::new('words', 'words', [CompletionResultType]::ParameterValue, 'Word/character/line counts for a document (JSON)')
            [CompletionResult]::new('help', 'help', [CompletionResultType]::ParameterValue, 'Print this message or the help of the given subcommand(s)')
            break
        }
        'whetstone-tui;help;open' {
            break
        }
        'whetstone-tui;help;lint' {
            break
        }
        'whetstone-tui;help;coach' {
            break
        }
        'whetstone-tui;help;guard' {
            break
        }
        'whetstone-tui;help;ownership' {
            break
        }
        'whetstone-tui;help;disclosure' {
            break
        }
        'whetstone-tui;help;export' {
            break
        }
        'whetstone-tui;help;words' {
            break
        }
        'whetstone-tui;help;help' {
            break
        }
    })

    $completions.Where{ $_.CompletionText -like "$wordToComplete*" } |
        Sort-Object -Property ListItemText
}
