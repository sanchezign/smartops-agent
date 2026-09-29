#!/usr/bin/env bash
# README media (phase 13 M6): turns what apps/admin/e2e/media.spec.ts recorded into
#   docs/media/*.webp     screenshots (desktop 1440 px, iPhone 590 px wide), light + dark
#   docs/media/demo.gif   the demo flow with English captions (README)
#   <kit>/smartops-demo.mp4 + .en.srt + .es.srt   the clean video for YouTube and clients
#   docs/guide/media-{en,es}/*.webp               the panel guide screenshots (phase 13 M7)
# The kit folder is OUTSIDE the repository (default ../smartops-portfolio-kit/video).
# ffmpeg runs in a pinned container (no local install).
#   scripts/media/build-media.sh [kit folder]
#   scripts/media/build-media.sh --guide          only the guide screenshots
set -euo pipefail
export MSYS_NO_PATHCONV=1
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

root="$(native "$(cd "$(dirname "$0")/../.." && pwd)")"
src="$root/apps/admin/e2e/screens/media"
out="$root/docs/media"
guide="$root/docs/guide"
guide_only=false
if [ "${1:-}" = "--guide" ]; then guide_only=true; shift; fi
kit="${1:-$root/../smartops-portfolio-kit/video}"
mkdir -p "$out" "$kit" "$guide"
kit="$(native "$(cd "$kit" && pwd)")"
FFMPEG="jrottenberg/ffmpeg:7.1-alpine@sha256:8ec1ee1f6a0fcd37c97725827b6b7832795c9596e3439b8da56d7700d61ae778"
ff() { docker run --rm -v "$src:/in:ro" -v "$out:/out" -v "$kit:/kit" -v "$guide:/guide" "$FFMPEG" -hide_banner -loglevel error -y "$@"; }

guide_shots() {
  local lang name
  for lang in en es; do
    mkdir -p "$guide/media-$lang"
    for png in "$src"/guide-"$lang"-*.png; do
      [ -e "$png" ] || continue
      name="$(basename "$png" .png)"
      name="${name#guide-"$lang"-}"
      ff -i "/in/guide-$lang-$name.png" -vf "scale=1080:-2:flags=lanczos" -c:v libwebp -quality 78 \
        "/guide/media-$lang/$name.webp"
    done
  done
  du -ch "$guide"/media-*/* | tail -n 1
}

if $guide_only; then
  echo "== guide screenshots → WebP"
  guide_shots
  exit 0
fi

echo "== screenshots → WebP"
for name in dashboard review-columns product chat; do
  for scheme in light dark; do
    ff -i "/in/desktop-$name-$scheme.png" -c:v libwebp -quality 82 "/out/desktop-$name-$scheme.webp"
  done
done
for name in dashboard reviews inbox; do
  for scheme in light dark; do
    ff -i "/in/iphone-$name-$scheme.png" -vf "scale=590:-2:flags=lanczos" -c:v libwebp -quality 80 \
      "/out/iphone-$name-$scheme.webp"
  done
done

echo "== demo.gif (English captions)"
ff -i /in/demo-captions.webm \
  -vf "fps=7,scale=880:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  /out/demo.gif

echo "== clean video + subtitles → $kit"
ff -i /in/demo-clean.webm -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -movflags +faststart \
  /kit/smartops-demo.mp4
cp "$src/demo-clean.en.srt" "$kit/smartops-demo.en.srt"
cp "$src/demo-clean.es.srt" "$kit/smartops-demo.es.srt"

echo "== sizes"
du -ch "$out"/* | tail -n 1
find "$out" "$kit" -maxdepth 1 -type f -printf '%s %f\n'
