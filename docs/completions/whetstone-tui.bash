_whetstone-tui() {
    local i cur prev opts cmd
    COMPREPLY=()
    if [[ "${BASH_VERSINFO[0]}" -ge 4 ]]; then
        cur="$2"
    else
        cur="${COMP_WORDS[COMP_CWORD]}"
    fi
    prev="$3"
    cmd=""
    opts=""

    for i in "${COMP_WORDS[@]:0:COMP_CWORD}"
    do
        case "${cmd},${i}" in
            ",$1")
                cmd="whetstone__tui"
                ;;
            whetstone__tui,coach)
                cmd="whetstone__tui__subcmd__coach"
                ;;
            whetstone__tui,disclosure)
                cmd="whetstone__tui__subcmd__disclosure"
                ;;
            whetstone__tui,export)
                cmd="whetstone__tui__subcmd__export"
                ;;
            whetstone__tui,guard)
                cmd="whetstone__tui__subcmd__guard"
                ;;
            whetstone__tui,help)
                cmd="whetstone__tui__subcmd__help"
                ;;
            whetstone__tui,lint)
                cmd="whetstone__tui__subcmd__lint"
                ;;
            whetstone__tui,open)
                cmd="whetstone__tui__subcmd__open"
                ;;
            whetstone__tui,ownership)
                cmd="whetstone__tui__subcmd__ownership"
                ;;
            whetstone__tui__subcmd__help,coach)
                cmd="whetstone__tui__subcmd__help__subcmd__coach"
                ;;
            whetstone__tui__subcmd__help,disclosure)
                cmd="whetstone__tui__subcmd__help__subcmd__disclosure"
                ;;
            whetstone__tui__subcmd__help,export)
                cmd="whetstone__tui__subcmd__help__subcmd__export"
                ;;
            whetstone__tui__subcmd__help,guard)
                cmd="whetstone__tui__subcmd__help__subcmd__guard"
                ;;
            whetstone__tui__subcmd__help,help)
                cmd="whetstone__tui__subcmd__help__subcmd__help"
                ;;
            whetstone__tui__subcmd__help,lint)
                cmd="whetstone__tui__subcmd__help__subcmd__lint"
                ;;
            whetstone__tui__subcmd__help,open)
                cmd="whetstone__tui__subcmd__help__subcmd__open"
                ;;
            whetstone__tui__subcmd__help,ownership)
                cmd="whetstone__tui__subcmd__help__subcmd__ownership"
                ;;
            *)
                ;;
        esac
    done

    case "${cmd}" in
        whetstone__tui)
            opts="-h -V --help --version open lint coach guard ownership disclosure export help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 1 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__coach)
            opts="-h --message --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --message)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__disclosure)
            opts="-h --journal --doc-id --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --journal)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --doc-id)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__export)
            opts="-h --format --out --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --format)
                    COMPREPLY=($(compgen -W "html text" -- "${cur}"))
                    return 0
                    ;;
                --out)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__guard)
            opts="-h --reply --draft --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --reply)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --draft)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__help)
            opts="open lint coach guard ownership disclosure export help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__help__subcmd__coach)
            opts=""
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__help__subcmd__disclosure)
            opts=""
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__help__subcmd__export)
            opts=""
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__help__subcmd__guard)
            opts=""
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__help__subcmd__help)
            opts=""
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__help__subcmd__lint)
            opts=""
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__help__subcmd__open)
            opts=""
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__help__subcmd__ownership)
            opts=""
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 3 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__lint)
            opts="-h --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__open)
            opts="-h --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        whetstone__subcmd__tui__subcmd__ownership)
            opts="-h --original --current --help"
            if [[ ${cur} == -* || ${COMP_CWORD} -eq 2 ]] ; then
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi
            case "${prev}" in
                --original)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                --current)
                    COMPREPLY=($(compgen -f "${cur}"))
                    return 0
                    ;;
                *)
                    COMPREPLY=()
                    ;;
            esac
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
    esac
}

if [[ "${BASH_VERSINFO[0]}" -eq 4 && "${BASH_VERSINFO[1]}" -ge 4 || "${BASH_VERSINFO[0]}" -gt 4 ]]; then
    complete -F _whetstone-tui -o nosort -o bashdefault -o default whetstone-tui
else
    complete -F _whetstone-tui -o bashdefault -o default whetstone-tui
fi
