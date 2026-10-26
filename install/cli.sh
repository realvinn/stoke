#!/bin/sh
# Run from an extracted self-contained CLI release. No registry or runtime download.
set -eu
source_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
install_root=${STOKE_INSTALL_ROOT:-"$HOME/.local/share/stoke-cli"}
bin_dir=${STOKE_BIN_DIR:-"$HOME/.local/bin"}
case ${1:-install} in
  install)
    [ -x "$source_dir/runtime/node" ] || { printf '%s\n' 'Run this installer from an extracted Stoke CLI release.' >&2; exit 1; }
    version=$("$source_dir/runtime/node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version' "$source_dir/release.json")
    target=$("$source_dir/runtime/node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).target' "$source_dir/release.json")
    dest=$install_root/versions/$version-$target
    mkdir -p "$install_root/versions" "$bin_dir"
    if [ ! -d "$dest" ]; then
      stage=$install_root/versions/.$version-$target.$$
      mkdir "$stage"
      cp -R "$source_dir/." "$stage/"
      mv "$stage" "$dest"
    fi
    command=$bin_dir/stoke
    if [ -e "$command" ] || [ -L "$command" ]; then
      current=$(readlink "$command" 2>/dev/null || true)
      case $current in "$install_root"/versions/*/stoke) : ;; *) printf 'Leaving existing %s untouched. Choose STOKE_BIN_DIR for this CLI.\n' "$command" >&2; exit 1 ;; esac
    fi
    ln -s "$dest/stoke" "$bin_dir/.stoke-link.$$"
    mv -f "$bin_dir/.stoke-link.$$" "$command"
    printf 'Installed Stoke CLI %s at %s\n' "$version" "$command"
    case :$PATH: in *:"$bin_dir":*) : ;; *) printf 'Add %s to your PATH.\n' "$bin_dir" ;; esac
    ;;
  uninstall)
    current=$(readlink "$bin_dir/stoke" 2>/dev/null || true)
    case $current in "$install_root"/versions/*/stoke) rm "$bin_dir/stoke" ;; *) printf '%s\n' 'No CLI-owned command link to remove.' ;; esac
    printf '%s\n' 'Command removed. Installed versions, settings and chats are retained.'
    ;;
  *) printf '%s\n' 'Usage: install.sh [install|uninstall]' >&2; exit 1 ;;
esac
