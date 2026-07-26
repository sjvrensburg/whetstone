
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
            [CompletionResult]::new('words', 'words', [CompletionResultType]::ParameterValue, 'Word counts for a document (prose + raw + characters/lines)')
            [CompletionResult]::new('help', 'help', [CompletionResultType]::ParameterValue, 'Print this message or the help of the given subcommand(s)')
            break
        }
        'whetstone-tui;open' {
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;lint' {
            [CompletionResult]::new('--strict', '--strict', [CompletionResultType]::ParameterName, 'Exit non-zero when any diagnostics are found (for CI: `lint --strict` fails the step on spelling/grammar issues). Without this flag the command always exits 0 and reports findings as JSON')
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;coach' {
            [CompletionResult]::new('--message', '--message', [CompletionResultType]::ParameterName, 'The message to send the coach')
            [CompletionResult]::new('--journal', '--journal', [CompletionResultType]::ParameterName, 'Append a metadata-only `CoachConsult` event to this journal file, so a later `disclosure` render is honest that the coach was consulted headlessly (the agent/CI path is otherwise off-the-books). Creates the file if missing; appends to an existing JSON array. The judge fail-open path also records a `JudgeUnavailable` event')
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;guard' {
            [CompletionResult]::new('--reply', '--reply', [CompletionResultType]::ParameterName, 'The candidate reply text to screen')
            [CompletionResult]::new('--draft', '--draft', [CompletionResultType]::ParameterName, 'Optional draft file for n-gram-overlap screening')
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;ownership' {
            [CompletionResult]::new('--original', '--original', [CompletionResultType]::ParameterName, 'The original pasted text')
            [CompletionResult]::new('--current', '--current', [CompletionResultType]::ParameterName, 'The current text')
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;disclosure' {
            [CompletionResult]::new('--journal', '--journal', [CompletionResultType]::ParameterName, 'Path to a JSON array of `ProcessEvent`s')
            [CompletionResult]::new('--doc-id', '--doc-id', [CompletionResultType]::ParameterName, 'Document id shown in the disclosure (default: the journal path)')
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help')
            break
        }
        'whetstone-tui;export' {
            [CompletionResult]::new('--format', '--format', [CompletionResultType]::ParameterName, 'Output format')
            [CompletionResult]::new('--out', '--out', [CompletionResultType]::ParameterName, 'Output path (default: `<file>.html` or `<file>.txt`)')
            [CompletionResult]::new('-h', '-h', [CompletionResultType]::ParameterName, 'Print help (see more with ''--help'')')
            [CompletionResult]::new('--help', '--help', [CompletionResultType]::ParameterName, 'Print help (see more with ''--help'')')
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
            [CompletionResult]::new('words', 'words', [CompletionResultType]::ParameterValue, 'Word counts for a document (prose + raw + characters/lines)')
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
