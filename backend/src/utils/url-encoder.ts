/**
 * URL encoding for go2rtc API.
 *
 * go2rtc PUT /api/streams?name=X&src=Y expects the src value
 * to be a single URL parameter. But RTSP URLs contain & and
 * go2rtc directives use #. Both must be encoded or they break:
 *   & in RTSP query → %26  (otherwise splits HTTP params)
 *   # for directives → %23  (otherwise treated as URL fragment)
 *   spaces            → %20
 */
export function encodeGo2rtcSource(source: string): string {
  return source
    .replace(/\?([^#]*)/, (_, params: string) =>
      '?' + params.replace(/&/g, '%26')
    )
    .replace(/#/g, '%23')
    .replace(/ /g, '%20');
}
