#!/usr/bin/env bash
set -euo pipefail
font_stage=$(mktemp -d)
trap 'rm -rf "$font_stage"' EXIT
cd "$font_stage"
curl --fail --location --max-time 60 --retry 2 --output liberation.tar.gz https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz
printf '%s  liberation.tar.gz\n' 7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0 | sha256sum --check
curl --fail --location --max-time 60 --retry 2 --output dejavu.tar.bz2 https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2
printf '%s  dejavu.tar.bz2\n' fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7 | sha256sum --check
tar -xzf liberation.tar.gz
tar -xjf dejavu.tar.bz2
mkdir -p /usr/local/share/fonts/proser-fixtures /usr/local/share/doc/proser-fixture-fonts/liberation /usr/local/share/doc/proser-fixture-fonts/dejavu
cp liberation-fonts-ttf-2.1.5/*.ttf dejavu-fonts-ttf-2.37/ttf/*.ttf /usr/local/share/fonts/proser-fixtures/
cp liberation-fonts-ttf-2.1.5/LICENSE /usr/local/share/doc/proser-fixture-fonts/liberation/
cp dejavu-fonts-ttf-2.37/LICENSE /usr/local/share/doc/proser-fixture-fonts/dejavu/
fc-cache --force
