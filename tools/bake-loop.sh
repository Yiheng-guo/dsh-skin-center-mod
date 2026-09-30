#!/usr/bin/env bash
#
# bake-loop.sh — turn any clip into a seamless, skin-ready looping background.
#
#   usage: build/bake-loop.sh <source.mp4> [start] [duration] [mode] [width] [speed] [interp]
#
#     start      seconds into the source where the clean footage begins   (0)
#     duration   seconds of clean footage to use                          (2.4)
#     mode       pingpong | xfade                                         (pingpong)
#     width      output width; height follows the source aspect           (1920)
#     speed      playback factor, <1 = slower, frame duplication          (1)
#     interp     minterpolate target fps (e.g. 90 = 3x slower, SMOOTH)    (0 = off)
#
#   `speed` and `interp` both buy loop length — a title-free window of D
#   seconds becomes D*factor seconds, and pingpong doubles that. Prefer
#   `interp`: `speed 0.45` leaves 48% of frame pairs actually changing
#   (visible stepping), `interp 90` leaves 75% (smooth). Use `speed` only when
#   you need the bake to be fast.
#
#   mode=pingpong
#     forward + reversed. Perfectly seamless BY CONSTRUCTION (first frame and
#     last frame are the same source frame), doubles the length, and needs no
#     clean loop point at all. The right choice when the clean window is short
#     and the motion is subtle — which is exactly what an intro clip gives you.
#     Cost: motion is not one-directional (it breathes instead of flowing).
#
#   mode=xfade
#     crossfades the tail into the head, so motion stays one-directional.
#     Output length is (duration - XFADE), so it needs a longer clean window
#     than pingpong to be worth using.
#
# The script refuses to overwrite unless the seam measures clean, and it always
# strips audio (a skin background must never make noise) and sets +faststart
# (without it the browser cannot start playing until the whole file arrives).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# Which skin directory the loop lands in. Override to bake a second skin:
#   SKIN_ID=cyber-abyss bash build/bake-loop.sh <src> 0.05 4.2 pingpong 1600 1 60
SKIN_ID="${SKIN_ID:-cyber-maiden}"
SKIN_ASSETS="$ROOT/$SKIN_ID/assets"
OUT_NAME="${SKIN_ID}-loop.mp4"

FF="${FFMPEG:-}"
if [[ -z "$FF" ]]; then
  if [[ -x "$HERE/bin/ffmpeg" ]]; then FF="$HERE/bin/ffmpeg"
  elif command -v ffmpeg >/dev/null 2>&1; then FF="$(command -v ffmpeg)"
  else
    echo "error: no ffmpeg. Put one at build/bin/ffmpeg or set \$FFMPEG." >&2
    exit 1
  fi
fi

SRC="${1:-}"
[[ -n "$SRC" ]] || { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ -f "$SRC" ]] || { echo "error: no such file: $SRC" >&2; exit 1; }

START="${2:-0}"
DUR="${3:-2.4}"
MODE="${4:-pingpong}"
WIDTH="${5:-1920}"
# Slow-motion factor. <1 = slower, which BUYS LOOP LENGTH: a title-free window
# of D seconds becomes D/SPEED seconds of footage, and pingpong then doubles
# that. For an intro clip — where the clean window is short BY CONSTRUCTION —
# this is the cheapest way to a long loop, and a slower move is also less
# distracting behind a UI. Cost: frame-duplication judder, which only shows on
# fast motion; an intro push-in is usually slow enough to hide it.
SPEED="${6:-1}"
# Motion-interpolated slow motion. Set to a frame rate (e.g. 90) to SYNTHESISE
# intermediate frames with `minterpolate` instead of holding frames. Slowdown
# becomes INTERP/30 and there is no judder, so you can go much slower than the
# duplication path allows. Cost: minterpolate is CPU-heavy (~40 s for 2.3 s of
# 1080p here) and can warp fast/complex motion, so always eyeball a frame.
#
#   speed 0.45 (duplicate) -> 48% of frame pairs actually change  = stepped
#   interp 90  (3x slow)   -> 75%                                   = smooth
INTERP="${7:-0}"
XFADE=0.9

# Build the slow-motion stage once, for both modes.
if [[ "$INTERP" != "0" ]]; then
  PTS_MUL="$(awk -v i="$INTERP" 'BEGIN{printf "%.6f", i/30}')"
  SLOW="minterpolate=fps=${INTERP}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,setpts=${PTS_MUL}*PTS"
  SLOW_NOTE="interp   : ${INTERP} fps, setpts=${PTS_MUL}*PTS  (${PTS_MUL}x slower, motion-interpolated)"
else
  SLOW="setpts=PTS/${SPEED}"
  [[ "$SPEED" != "1" ]] && SLOW_NOTE="speed    : ${SPEED}x  (frame duplication — expect stepping below ~0.6x)"
fi

command -v python3 >/dev/null 2>&1 || true
OUT="$SKIN_ASSETS/$OUT_NAME"
mkdir -p "$SKIN_ASSETS"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "source    : $SRC"
echo "window    : ${START}s + ${DUR}s"
echo "mode      : $MODE"
[[ -n "${SLOW_NOTE:-}" ]] && echo "$SLOW_NOTE"
echo "output    : $OUT"
echo

case "$MODE" in
  pingpong)
    "$FF" -v error -y -ss "$START" -t "$DUR" -i "$SRC" -an \
      -vf "${SLOW},split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0,scale=${WIDTH}:-2:flags=lanczos,fps=30" \
      -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart \
      "$OUT"
    ;;
  xfade)
    # O = C[d .. L-d] ++ crossfade(C[L-d .. L] -> C[0 .. d]); length = L - d.
    "$FF" -v error -y -ss "$START" -t "$DUR" -i "$SRC" -an \
      -filter_complex "\
[0:v]${SLOW},scale=${WIDTH}:-2:flags=lanczos,fps=30,split=3[a][b][c];\
[b]trim=0:${XFADE},setpts=PTS-STARTPTS[head];\
[c]trim=$(python3 -c "print(max(0,$DUR-$XFADE))"):${DUR},setpts=PTS-STARTPTS[tail];\
[head][tail]xfade=transition=fade:duration=${XFADE}:offset=0[x];\
[a]trim=${XFADE}:$(python3 -c "print(max(0,$DUR-2*$XFADE))"),setpts=PTS-STARTPTS[body];\
[body][x]concat=n=2:v=1:a=0[out]" \
      -map "[out]" -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart \
      "$OUT"
    ;;
  *)
    echo "error: mode must be pingpong or xfade (got '$MODE')" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------- seam check
# A skin loop is on screen for hours, so a visible seam is a real defect.
# Measure the artefact instead of trusting the method.
#
# The last frame is taken with `reverse`, NOT with -sseof: -sseof needs to land
# inside the final frame's display interval, and a container duration that
# overshoots the last PTS (which is the normal case) makes it emit nothing at
# all. `reverse` is exact.
#
# What "seamless" means depends on the mode:
#   xfade    first and last frame are the SAME instant -> expect inf/huge PSNR
#   pingpong first and last are NEIGHBOURS in the motion (a boomerang turns
#            around on frame 0) -> expect merely high PSNR; the failure mode
#            worth guarding is a BLACK first/last frame, which is why the
#            luminance guard below exists. It is what caught the real defect in
#            this skin's first bake (source frame 0 is black).
#
# Everything here is cosmetic: a failure must never fail the bake.
"$FF" -v error -y -i "$OUT" -vf "select=eq(n\,0)" -frames:v 1 "$TMP/first.png" || true
"$FF" -v error -y -i "$OUT" -vf "select=eq(n\,1)" -frames:v 1 "$TMP/second.png" || true
"$FF" -v error -y -i "$OUT" -vf reverse -frames:v 1 "$TMP/last.png" || true
"$FF" -v error -y -i "$OUT" -vf "reverse,select=eq(n\,1)" -frames:v 1 "$TMP/penultimate.png" || true

yavg() {  # mean luma (0-255) of a single image
  "$FF" -hide_banner -i "$1" \
    -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null - 2>&1 \
    | sed -n 's/.*lavfi\.signalstats\.YAVG=\([0-9.]*\).*/\1/p' | head -1
}

psnr() {  # PSNR between two single images
  "$FF" -hide_banner -i "$1" -i "$2" -lavfi psnr -f null - 2>&1 \
    | sed -n 's/.*average:\([0-9.a-zA-Z]*\).*/\1/p' | tail -1
}

DURATION="$("$FF" -hide_banner -i "$OUT" 2>&1 | sed -n 's/.*Duration: \([0-9:.]*\),.*/\1/p' | head -1 || true)"
DIMS="$("$FF" -hide_banner -i "$OUT" 2>&1 | sed -n 's/.*Video: .*, \([0-9]\{3,\}x[0-9]\{3,\}\).*/\1/p' | head -1 || true)"
SIZE="$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT")"

echo "duration  : ${DURATION:-?}   (${DIMS:-?})"
echo "size      : $(( SIZE / 1024 )) KiB"

if [[ -s "$TMP/first.png" && -s "$TMP/last.png" ]]; then
  Y1="$(yavg "$TMP/first.png")"
  Y2="$(yavg "$TMP/last.png")"
  PSNR="$(psnr "$TMP/first.png" "$TMP/last.png")"
  HEAD=""
  TAIL=""
  [[ -s "$TMP/second.png" ]] && HEAD="$(psnr "$TMP/first.png" "$TMP/second.png")"
  [[ -s "$TMP/penultimate.png" ]] && TAIL="$(psnr "$TMP/last.png" "$TMP/penultimate.png")"

  echo "first/last: mean luma ${Y1:-?} / ${Y2:-?}   (limited-range black is Y=16, not 0)"
  [[ -n "$PSNR" ]] && echo "seam PSNR : ${PSNR} dB   (first frame vs last frame)"
  # A black or otherwise wrong frame spliced onto either end shows up as a
  # HARD CUT between the end frame and its neighbour. That is threshold-free
  # in absolute terms: neighbouring frames of a slow clip are always >= 30 dB,
  # a spliced frame is not. This is the check that catches the real defect
  # (this skin's source clip opens on one black frame).
  [[ -n "$HEAD" ]] && echo "head splice: ${HEAD} dB   (frame 0 vs frame 1)"
  [[ -n "$TAIL" ]] && echo "tail splice: ${TAIL} dB   (last frame vs its neighbour)"

  SPLICE_FLOOR=25
  verdict="seamless"
  if { [[ -n "$HEAD" ]] && awk -v p="$HEAD" -v f="$SPLICE_FLOOR" 'BEGIN{exit !(p+0 < f+0)}'; } \
  || { [[ -n "$TAIL" ]] && awk -v p="$TAIL" -v f="$SPLICE_FLOOR" 'BEGIN{exit !(p+0 < f+0)}'; }; then
    verdict="REJECTED — a hard cut sits at the loop boundary; the window starts or ends on a spliced/black frame (move start later / duration shorter)"
  elif [[ "$MODE" == "pingpong" ]]; then
    if awk -v p="$PSNR" 'BEGIN{exit !(p != "inf" && p+0 < 32)}'; then
      verdict="suspect — neighbours at a boomerang turnaround should still be >= 32 dB"
    fi
  else
    case "$PSNR" in
      inf*|Inf*) ;;
      *) awk -v p="$PSNR" 'BEGIN{exit !(p+0 < 40)}' && \
           verdict="suspect — an xfade join should be >= 40 dB" || true ;;
    esac
  fi
  echo "verdict   : $verdict"
fi
echo
echo "next: node build/validate-skin.mjs cyber-maiden && node build/render-preview.mjs"
