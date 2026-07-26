# Print an optspec for argparse to handle cmd's options that are independent of any subcommand.
function __fish_whetstone_tui_global_optspecs
    string join \n h/help V/version
end

function __fish_whetstone_tui_needs_command
    # Figure out if the current invocation already has a command.
    set -l cmd (commandline -opc)
    set -e cmd[1]
    argparse -s (__fish_whetstone_tui_global_optspecs) -- $cmd 2>/dev/null
    or return
    if set -q argv[1]
        # Also print the command, so this can be used to figure out what it is.
        echo $argv[1]
        return 1
    end
    return 0
end

function __fish_whetstone_tui_using_subcommand
    set -l cmd (__fish_whetstone_tui_needs_command)
    test -z "$cmd"
    and return 1
    contains -- $cmd[1] $argv
end

complete -c whetstone-tui -n "__fish_whetstone_tui_needs_command" -s h -l help -d 'Print help'
complete -c whetstone-tui -n "__fish_whetstone_tui_needs_command" -s V -l version -d 'Print version'
complete -c whetstone-tui -n "__fish_whetstone_tui_needs_command" -a "open" -d 'Open the editor (same as passing a bare file path)'
complete -c whetstone-tui -n "__fish_whetstone_tui_needs_command" -a "lint" -d 'Lint a file with Harper; prints diagnostics as JSON'
complete -c whetstone-tui -n "__fish_whetstone_tui_needs_command" -a "coach" -d 'Run one coach turn over a file, screened by the guard (+ judge if set)'
complete -c whetstone-tui -n "__fish_whetstone_tui_needs_command" -a "guard" -d 'Screen an arbitrary reply with the deterministic guard (+ judge if set)'
complete -c whetstone-tui -n "__fish_whetstone_tui_needs_command" -a "ownership" -d 'Claim-to-own survival of an original paste within the current text'
complete -c whetstone-tui -n "__fish_whetstone_tui_needs_command" -a "disclosure" -d 'Render a disclosure document from a journal (a JSON array of events)'
complete -c whetstone-tui -n "__fish_whetstone_tui_needs_command" -a "export" -d 'Export a `.qmd` / `.md` document as HTML or plain text (no Quarto needed)'
complete -c whetstone-tui -n "__fish_whetstone_tui_needs_command" -a "words" -d 'Word counts for a document (prose + raw + characters/lines)'
complete -c whetstone-tui -n "__fish_whetstone_tui_needs_command" -a "help" -d 'Print this message or the help of the given subcommand(s)'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand open" -s h -l help -d 'Print help'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand lint" -l strict -d 'Exit non-zero when any diagnostics are found (for CI: `lint --strict` fails the step on spelling/grammar issues). Without this flag the command always exits 0 and reports findings as JSON'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand lint" -s h -l help -d 'Print help'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand coach" -l message -d 'The message to send the coach' -r
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand coach" -l journal -d 'Append a metadata-only `CoachConsult` event to this journal file, so a later `disclosure` render is honest that the coach was consulted headlessly (the agent/CI path is otherwise off-the-books). Creates the file if missing; appends to an existing JSON array. The judge fail-open path also records a `JudgeUnavailable` event' -r -F
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand coach" -s h -l help -d 'Print help'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand guard" -l reply -d 'The candidate reply text to screen' -r
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand guard" -l draft -d 'Optional draft file for n-gram-overlap screening' -r -F
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand guard" -s h -l help -d 'Print help'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand ownership" -l original -d 'The original pasted text' -r -F
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand ownership" -l current -d 'The current text' -r -F
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand ownership" -s h -l help -d 'Print help'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand disclosure" -l journal -d 'Path to a JSON array of `ProcessEvent`s' -r -F
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand disclosure" -l doc-id -d 'Document id shown in the disclosure (default: the journal path)' -r
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand disclosure" -s h -l help -d 'Print help'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand export" -l format -d 'Output format' -r -f -a "html\t'A standalone HTML5 document'
text\t'Plain text, as rendered by the preview pane'"
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand export" -l out -d 'Output path (default: `<file>.html` or `<file>.txt`)' -r -F
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand export" -s h -l help -d 'Print help (see more with \'--help\')'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand words" -s h -l help -d 'Print help'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand help; and not __fish_seen_subcommand_from open lint coach guard ownership disclosure export words help" -f -a "open" -d 'Open the editor (same as passing a bare file path)'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand help; and not __fish_seen_subcommand_from open lint coach guard ownership disclosure export words help" -f -a "lint" -d 'Lint a file with Harper; prints diagnostics as JSON'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand help; and not __fish_seen_subcommand_from open lint coach guard ownership disclosure export words help" -f -a "coach" -d 'Run one coach turn over a file, screened by the guard (+ judge if set)'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand help; and not __fish_seen_subcommand_from open lint coach guard ownership disclosure export words help" -f -a "guard" -d 'Screen an arbitrary reply with the deterministic guard (+ judge if set)'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand help; and not __fish_seen_subcommand_from open lint coach guard ownership disclosure export words help" -f -a "ownership" -d 'Claim-to-own survival of an original paste within the current text'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand help; and not __fish_seen_subcommand_from open lint coach guard ownership disclosure export words help" -f -a "disclosure" -d 'Render a disclosure document from a journal (a JSON array of events)'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand help; and not __fish_seen_subcommand_from open lint coach guard ownership disclosure export words help" -f -a "export" -d 'Export a `.qmd` / `.md` document as HTML or plain text (no Quarto needed)'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand help; and not __fish_seen_subcommand_from open lint coach guard ownership disclosure export words help" -f -a "words" -d 'Word counts for a document (prose + raw + characters/lines)'
complete -c whetstone-tui -n "__fish_whetstone_tui_using_subcommand help; and not __fish_seen_subcommand_from open lint coach guard ownership disclosure export words help" -f -a "help" -d 'Print this message or the help of the given subcommand(s)'
