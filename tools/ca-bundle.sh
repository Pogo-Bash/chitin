#!/bin/sh
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
#
# The engine's trust store: Mozilla's CA certificate bundle as curl publishes it (MPL-2.0,
# https://curl.se/docs/caextract.html), into $CHITIN_EXT/ca/cacert.pem, served to segments as
# /chitin/cacert.pem. Re-run to update; the file's header says when Mozilla's data was taken.
set -eu
CHITIN_EXT="${CHITIN_EXT:-$HOME/dev/chitin-ext}"
mkdir -p "$CHITIN_EXT/ca"
curl -sSL -o "$CHITIN_EXT/ca/cacert.pem.new" https://curl.se/ca/cacert.pem
grep -q "BEGIN CERTIFICATE" "$CHITIN_EXT/ca/cacert.pem.new"
mv "$CHITIN_EXT/ca/cacert.pem.new" "$CHITIN_EXT/ca/cacert.pem"
sed -n '2,4p' "$CHITIN_EXT/ca/cacert.pem"
echo "$(grep -c 'BEGIN CERTIFICATE' "$CHITIN_EXT/ca/cacert.pem") certificates in $CHITIN_EXT/ca/cacert.pem"
