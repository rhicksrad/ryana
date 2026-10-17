#!/usr/bin/env bash
# Stamp a fresh ?v= version on every stylesheet, page script and module import in docs/,
# so phones fetch the new files instead of mixing them with cached old ones.
# Run before committing any CSS or JS change.
set -euo pipefail
cd "$(dirname "$0")/docs"
v=$(date +%Y%m%d%H%M%S)
sed -i -E "s#(href=\"assets/app\.css)(\?v=[^\"]*)?\"#\1?v=$v\"#; s#(src=\"assets/[a-z]+\.js)(\?v=[^\"]*)?\"#\1?v=$v\"#" ./*.html
sed -i -E "s#from '(\.\.?/[a-z]+\.js)(\?v=[^']*)?'#from '\1?v=$v'#g" assets/*.js
echo "version $v"
