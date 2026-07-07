// Minimal logger. Redacts token=... from any URL strings before printing
// (tokens may appear in WS handshake URLs / access logs).

function redactToken(s) {
  return String(s).replace(/([?&]token=)([^&\s#]+)/gi, '$1<redacted>');
}

function fmt(level, args) {
  const parts = args.map((a) => (typeof a === 'string' ? redactToken(a) : a));
  return `[${level}] ${parts.join(' ')}`;
}

export const logger = {
  info: (...a) => console.log(fmt('info', a)),
  warn: (...a) => console.warn(fmt('warn', a)),
  error: (...a) => console.error(fmt('error', a)),
};
