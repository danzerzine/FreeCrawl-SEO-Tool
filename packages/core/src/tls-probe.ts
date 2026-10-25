import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { connect, type PeerCertificate, type TLSSocket } from 'node:tls';

/**
 * Result of probing the TLS certificate served by `host:port`. All string
 * fields are populated on success; the date fields are RFC 1123 strings
 * (the format Node returns from `peerCert.valid_from` /
 * `peerCert.valid_to`). On failure, `error` is set and the rest are null.
 */
export interface TlsCertInfo {
  validFrom: string | null;
  validTo: string | null;
  daysUntilExpiry: number | null;
  issuer: string | null;
  subject: string | null;
  signatureAlgorithm: string | null;
  /** Negotiated TLS protocol version, e.g. `TLSv1.3`. */
  protocol: string | null;
  /**
   * Outcome of a second handshake capped at TLS 1.1: `TLSv1` / `TLSv1.1`
   * when the server still accepts it, `refused` when it does not, and
   * `untested` when the handshake could not be tried (no TCP connection,
   * or a timeout).
   */
  legacyProtocol: LegacyProtocolResult;
  /**
   * Number of certificates the server presented in its chain (leaf
   * inclusive). 1 means leaf-only / self-signed; 2 means leaf + root
   * with no intermediate; ≥3 indicates one or more intermediate CAs.
   * Null on probe failure.
   */
  chainLength: number | null;
  /**
   * Distinguished names of the certs in the chain, leaf-first. Capped
   * at 5 entries to keep the column tiny — corporate PKIs occasionally
   * present long chains and we don't need the full path for the audit.
   * Null on probe failure.
   */
  chainSubjects: string[] | null;
  /** Empty on success. Free-form error string when the connect/handshake fails. */
  error: string | null;
}

/**
 * Open a single TLS connection to the host and read the peer cert. We
 * disable certificate verification (`rejectUnauthorized: false`) because
 * the goal is to *audit* the cert — including expired or self-signed ones
 * — not to communicate securely. The returned data lets the caller
 * surface "certificate expired" / "expires in 12 days" issues which are
 * exactly the cases a verifying connect would refuse to surface at all.
 *
 * Times out at `timeoutMs`; on timeout the error string includes the
 * elapsed budget so it's clear in logs.
 */
export async function probeTlsCert(
  host: string,
  port = 443,
  timeoutMs = 10_000,
): Promise<TlsCertInfo> {
  // Set once TCP connects: the server is there, so the legacy handshake
  // is worth a try even when this one fails at the TLS level — a server
  // that speaks only TLS 1.0 / 1.1 fails it, and is the worst case.
  let tcpConnected = false;
  const info = await new Promise<TlsCertInfo>((resolve) => {
    const empty: TlsCertInfo = {
      validFrom: null,
      validTo: null,
      daysUntilExpiry: null,
      issuer: null,
      subject: null,
      signatureAlgorithm: null,
      protocol: null,
      legacyProtocol: 'untested',
      chainLength: null,
      chainSubjects: null,
      error: null,
    };

    let settled = false;
    const finish = (result: TlsCertInfo): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ...empty, error: `tls handshake timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const socket = connect(
      {
        host,
        port,
        // SNI carries host names only; an IP literal there is invalid.
        ...(isIP(host) === 0 ? { servername: host } : {}),
        rejectUnauthorized: false,
        // Don't keep the process alive waiting on a connect we already
        // gave up on — `unref` makes the socket non-blocking for shutdown.
        ALPNProtocols: ['h2', 'http/1.1'],
      },
      () => {
        clearTimeout(timer);
        try {
          // `getPeerCertificate(true)` returns the leaf cert with its
          // `issuerCertificate` chain attached so we can surface chain
          // length + intermediate CA subjects alongside the leaf
          // expiry/issuer/signature data.
          const peer = socket.getPeerCertificate(true) as PeerCertificate;
          if (!peer || Object.keys(peer).length === 0) {
            finish({ ...empty, error: 'peer certificate unavailable' });
            return;
          }
          // Walk the chain via `issuerCertificate` until we hit a
          // self-signed cert (issuerCertificate === self) or run out.
          // Capped at 5 hops to defend against weird PKIs that loop.
          const chainSubjects: string[] = [];
          let chainLength = 0;
          {
            let cursor: PeerCertificate | undefined = peer;
            const seen = new Set<PeerCertificate>();
            while (cursor && !seen.has(cursor) && chainLength < 5) {
              seen.add(cursor);
              chainLength++;
              const sub = formatDistinguishedName(
                (cursor as { subject?: Record<string, string> }).subject ?? null,
              );
              if (sub) chainSubjects.push(sub);
              const next: PeerCertificate | undefined = (
                cursor as { issuerCertificate?: PeerCertificate }
              ).issuerCertificate;
              if (!next || next === cursor) break;
              cursor = next;
            }
          }
          const validTo = (peer as { valid_to?: string }).valid_to ?? null;
          const validFrom = (peer as { valid_from?: string }).valid_from ?? null;
          let daysUntilExpiry: number | null = null;
          if (validTo) {
            const t = Date.parse(validTo);
            if (!Number.isNaN(t)) {
              daysUntilExpiry = Math.floor((t - Date.now()) / (24 * 60 * 60 * 1000));
            }
          }
          const protocol = socket.getProtocol() ?? null;
          finish({
            validFrom,
            validTo,
            daysUntilExpiry,
            issuer: formatDistinguishedName(
              (peer as { issuer?: Record<string, string> }).issuer ?? null,
            ),
            subject: formatDistinguishedName(
              (peer as { subject?: Record<string, string> }).subject ?? null,
            ),
            // The peer-certificate object carries no signature algorithm
            // (`sigalg` is never set), so read it from the leaf's DER.
            signatureAlgorithm: peer.raw ? certSignatureAlgorithm(peer.raw) : null,
            protocol,
            legacyProtocol: 'untested',
            chainLength,
            chainSubjects: chainSubjects.length > 0 ? chainSubjects : null,
            error: null,
          });
        } catch (err) {
          finish({
            ...empty,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    socket.on('error', (err) => {
      clearTimeout(timer);
      finish({ ...empty, error: err instanceof Error ? err.message : String(err) });
    });
    socket.on('timeout', () => {
      clearTimeout(timer);
      finish({ ...empty, error: 'socket timeout' });
    });
    socket.on('connect', () => {
      tcpConnected = true;
    });
    socket.setTimeout(timeoutMs);
  });
  if (tcpConnected) info.legacyProtocol = await probeLegacyProtocol(host, port, timeoutMs);
  return info;
}

export type LegacyProtocolResult = 'TLSv1' | 'TLSv1.1' | 'refused' | 'untested';

/**
 * The CBC suites TLS 1.0 / 1.1 servers negotiate. Named explicitly
 * because the default cipher list leaves them out, so the handshake would
 * fail on our side rather than the server's.
 */
const LEGACY_CIPHERS = [
  'ECDHE-ECDSA-AES128-SHA',
  'ECDHE-ECDSA-AES256-SHA',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-SHA',
  'AES256-SHA',
].join(':');

/**
 * The main handshake negotiates the best version both sides support and
 * never goes below TLS 1.2, so it cannot show whether a server still
 * accepts TLS 1.0 / 1.1. This one offers only those versions.
 *
 * OpenSSL 3 (Node — the CLI) offers the SHA-1 suites only with
 * `@SECLEVEL=0`; BoringSSL (Electron — the desktop app) rejects that
 * directive with ERR_SSL_INVALID_COMMAND but offers the suites without it.
 * So the OpenSSL spelling goes first and a rejected context retries
 * without it.
 */
async function probeLegacyProtocol(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<LegacyProtocolResult> {
  for (const ciphers of [`${LEGACY_CIPHERS}:@SECLEVEL=0`, LEGACY_CIPHERS]) {
    const result = await legacyHandshake(host, port, timeoutMs, ciphers);
    if (result !== 'bad-options') return result;
  }
  return 'untested';
}

function legacyHandshake(
  host: string,
  port: number,
  timeoutMs: number,
  ciphers: string,
): Promise<LegacyProtocolResult | 'bad-options'> {
  return new Promise((resolve) => {
    let socket: TLSSocket | undefined;
    let settled = false;
    const finish = (result: LegacyProtocolResult | 'bad-options'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    // A server that stalls on the legacy ClientHello says nothing either
    // way — unknown, not "refused".
    const timer = setTimeout(() => finish('untested'), timeoutMs);
    try {
      socket = connect(
        {
          host,
          port,
          // SNI carries host names only; an IP literal there is invalid.
          ...(isIP(host) === 0 ? { servername: host } : {}),
          rejectUnauthorized: false,
          minVersion: 'TLSv1',
          maxVersion: 'TLSv1.1',
          ciphers,
        },
        () => {
          const protocol = socket?.getProtocol();
          finish(protocol === 'TLSv1' || protocol === 'TLSv1.1' ? protocol : 'refused');
        },
      );
    } catch {
      // The TLS library rejected the options while building the context.
      finish('bad-options');
      return;
    }
    socket.on('error', () => finish('refused'));
  });
}

/**
 * Flatten Node's `tls.PeerCertificate` issuer/subject objects (which look
 * like `{ C: 'US', O: 'Google Trust Services', CN: 'WE1' }`) into a
 * compact string `CN=WE1, O=Google Trust Services, C=US`. The order
 * follows the most-specific-first convention used by `openssl x509`.
 */
function formatDistinguishedName(dn: Record<string, string> | null): string | null {
  if (!dn || typeof dn !== 'object') return null;
  const parts: string[] = [];
  for (const key of ['CN', 'O', 'OU', 'L', 'ST', 'C']) {
    const v = dn[key];
    if (typeof v === 'string' && v) parts.push(`${key}=${v}`);
  }
  if (parts.length === 0) return null;
  return parts.join(', ');
}

/** OpenSSL names of the common certificate signature algorithms, keyed by
 *  OID — used where `X509Certificate.signatureAlgorithm` is missing (it
 *  arrived in Node 24; the CLI still runs on Node 22.13+). */
const SIGNATURE_ALGORITHM_NAMES: Record<string, string> = {
  '1.2.840.113549.1.1.2': 'md2WithRSAEncryption',
  '1.2.840.113549.1.1.4': 'md5WithRSAEncryption',
  '1.2.840.113549.1.1.5': 'sha1WithRSAEncryption',
  '1.3.14.3.2.29': 'sha1WithRSA',
  '1.2.840.10040.4.3': 'dsa_with_SHA1',
  '1.2.840.10045.4.1': 'ecdsa-with-SHA1',
  '1.2.840.113549.1.1.10': 'RSASSA-PSS',
  '1.2.840.113549.1.1.11': 'sha256WithRSAEncryption',
  '1.2.840.113549.1.1.12': 'sha384WithRSAEncryption',
  '1.2.840.113549.1.1.13': 'sha512WithRSAEncryption',
  '1.2.840.113549.1.1.14': 'sha224WithRSAEncryption',
  '1.2.840.10045.4.3.1': 'ecdsa-with-SHA224',
  '1.2.840.10045.4.3.2': 'ecdsa-with-SHA256',
  '1.2.840.10045.4.3.3': 'ecdsa-with-SHA384',
  '1.2.840.10045.4.3.4': 'ecdsa-with-SHA512',
  '1.3.101.112': 'ED25519',
  '1.3.101.113': 'ED448',
};

/**
 * Signature algorithm of a DER certificate by its OpenSSL name
 * (`sha256WithRSAEncryption`, `ecdsa-with-SHA1`, …) — the spelling the
 * weak-signature check matches on. Unknown OIDs come back dotted.
 */
export function certSignatureAlgorithm(der: Buffer): string | null {
  try {
    const name = (new X509Certificate(der) as { signatureAlgorithm?: string })
      .signatureAlgorithm;
    if (name) return name;
  } catch {
    /* not parseable here — the DER walk below decides */
  }
  const oid = signatureAlgorithmOid(der);
  return oid ? (SIGNATURE_ALGORITHM_NAMES[oid] ?? oid) : null;
}

/**
 * The outer `signatureAlgorithm` OID of
 * `Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }`,
 * dotted. Null when the bytes are not shaped like a certificate.
 */
function signatureAlgorithmOid(der: Buffer): string | null {
  let pos = 0;
  // Consume one tag + length header; return the content length.
  const header = (tag: number): number | null => {
    if (der[pos++] !== tag) return null;
    let len = der[pos++];
    if (len === undefined) return null;
    if (len & 0x80) {
      const octets = len & 0x7f;
      if (octets === 0 || octets > 4) return null;
      len = 0;
      for (let i = 0; i < octets; i++) {
        const b = der[pos++];
        if (b === undefined) return null;
        len = len * 256 + b;
      }
    }
    return pos + len <= der.length ? len : null;
  };
  if (header(0x30) === null) return null; // Certificate
  const tbsLen = header(0x30); // tbsCertificate
  if (tbsLen === null) return null;
  pos += tbsLen;
  if (header(0x30) === null) return null; // AlgorithmIdentifier
  const oidLen = header(0x06);
  if (!oidLen) return null;
  const arcs: number[] = [];
  let value = 0;
  for (const b of der.subarray(pos, pos + oidLen)) {
    value = value * 128 + (b & 0x7f);
    if (b & 0x80) continue;
    if (arcs.length === 0) {
      // The first subidentifier packs the first two arcs as 40 * a + b.
      const first = Math.min(2, Math.floor(value / 40));
      arcs.push(first, value - first * 40);
    } else {
      arcs.push(value);
    }
    value = 0;
  }
  return arcs.length > 0 ? arcs.join('.') : null;
}
