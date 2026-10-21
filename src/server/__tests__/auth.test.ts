import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { COOKIE_NAME, createHostMatcher, isAuthorized, isLoopbackAddress, parseCookies, tokenMatches } from '../auth';

const req = (remote: string, headers: Record<string, string> = {}) =>
  ({ socket: { remoteAddress: remote }, headers }) as unknown as IncomingMessage;

describe('auth', () => {
  it('compara tokens', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('abc', 'abcd')).toBe(false);
    expect(tokenMatches('abc', '')).toBe(false);
    expect(tokenMatches('abc', undefined)).toBe(false);
  });

  it('detecta loopback', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.1.1']) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ['172.17.0.1', '192.168.1.20', '::ffff:192.168.65.1', undefined]) expect(isLoopbackAddress(a)).toBe(false);
  });

  it('sin token todo pasa', () => {
    expect(isAuthorized(req('192.168.1.5'), { token: null, bearer: true })).toBe(true);
  });

  it('con token: loopback exento, bearer y cookie según opciones', () => {
    const o = { token: 's3cret' };
    expect(isAuthorized(req('127.0.0.1'), { ...o, bearer: true })).toBe(true);
    expect(isAuthorized(req('192.168.1.5'), { ...o, bearer: true })).toBe(false);
    expect(isAuthorized(req('192.168.1.5', { authorization: 'Bearer s3cret' }), { ...o, bearer: true })).toBe(true);
    expect(isAuthorized(req('192.168.1.5', { authorization: 'Bearer nope' }), { ...o, bearer: true })).toBe(false);
    // El bearer no vale donde solo se acepta cookie, y viceversa.
    expect(isAuthorized(req('192.168.1.5', { authorization: 'Bearer s3cret' }), { ...o, cookie: true })).toBe(false);
    expect(isAuthorized(req('192.168.1.5', { cookie: `a=1; ${COOKIE_NAME}=s3cret` }), { ...o, cookie: true })).toBe(true);
    expect(isAuthorized(req('192.168.1.5', { cookie: `${COOKIE_NAME}=s3cret` }), { ...o, bearer: true })).toBe(false);
  });

  it('parsea cookies', () => {
    expect(parseCookies('a=1; b=hola%20mundo; =x; c')).toEqual({ a: '1', b: 'hola mundo' });
  });

  it('lista de hosts', () => {
    const local = createHostMatcher([]);
    expect(local.exposesNetwork).toBe(false);
    expect(local('localhost:7410')).toBe(true);
    expect(local('127.0.0.1:7411')).toBe(true);
    expect(local('[::1]:7410')).toBe(true);
    expect(local('evil.com:7410')).toBe(false);
    expect(local(undefined)).toBe(false);

    const lan = createHostMatcher(['raspberrypi.local', '192.168.1.20:7410', '[fe80::1]']);
    expect(lan.exposesNetwork).toBe(true);
    expect(lan('raspberrypi.local:7410')).toBe(true);
    expect(lan('RaspberryPi.local:8080')).toBe(true);
    expect(lan('192.168.1.20:7410')).toBe(true);
    expect(lan('192.168.1.20:9999')).toBe(false);
    expect(lan('[fe80::1]:7410')).toBe(true);
    expect(lan('otro.local:7410')).toBe(false);

    const any = createHostMatcher(['*']);
    expect(any.exposesNetwork).toBe(true);
    expect(any('cualquiera:1')).toBe(true);

    expect(createHostMatcher(['localhost', '127.0.0.1']).exposesNetwork).toBe(false);
  });
});
