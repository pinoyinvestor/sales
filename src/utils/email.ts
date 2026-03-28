// ─── Email Utilities ─────────────────────────────────────────────────────────

/**
 * Clean a raw email snippet by stripping MIME artifacts.
 * Works on both new incoming emails and existing DB data.
 */
// Built by Christos Ferlachidis & Daniel Hedenberg
export function cleanSnippet(raw: string): string {
  let text = raw

  // 1. Decode quoted-printable soft line breaks (=\r\n or =\n)
  text = text.replace(/=\r?\n/g, '')

  // 2. Decode quoted-printable encoded characters (e.g. =3D → =, =C3=A4 → ä)
  text = text.replace(/=([0-9A-Fa-f]{2})/g, (_match, hex) => {
    return String.fromCharCode(parseInt(hex, 16))
  })

  // 3. Strip "This is a MIME-encapsulated message" / "This is a multi-part message in MIME format"
  text = text.replace(/This is a (MIME-encapsulated|multi-?part) message[^\n]*/gi, '')

  // 4. Strip MIME boundary markers (lines starting with --)
  text = text.replace(/^--[A-Za-z0-9_.=/-]+\s*$/gm, '')

  // 5. Strip Content-Type / Content-Description / Content-Transfer-Encoding headers
  text = text.replace(/^Content-(Type|Description|Transfer-Encoding|Disposition):[^\n]*\n?/gim, '')

  // 6. Strip leftover MIME headers (charset, boundary, name params on continuation lines)
  text = text.replace(/^\s+(charset|boundary|name|filename)=[^\n]*\n?/gim, '')

  // 7. Collapse whitespace and trim
  text = text.replace(/\s+/g, ' ').trim()

  return text
}
