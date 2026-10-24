// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Sign-in handoff (docs/oauth.md): the carapace's rules for third-party sign-in, shared by carapace.js and the Node tests
// (tests/signin.test.mjs). Following RFC 8252 ("OAuth 2.0 for Native Apps", section 8.12), the identity provider's login page
// is not shown inside Chitin: the user continues it in their real browser, then brings the address the provider sent them
// back to (the site's redirect URI) into Chitin, where the site's own page finishes the flow. Nothing here reads, keeps or
// sends credentials or tokens: it decides what is a sign-in page and whether a pasted address may be used to return.
import { siteOf } from './guard.mjs';

// Hosts whose pages are sign-in pages of an identity provider (any path), and hosts where only some paths are.
// The generic rule below (an OAuth 2.0 / OpenID Connect authorization request) covers any other provider.
const IDP_HOSTS = new Set([
    'accounts.google.com',
    'appleid.apple.com',
    'idmsa.apple.com',
    'login.microsoftonline.com',
    'login.live.com',
    'login.windows.net',
    'account.live.com',
    'login.yahoo.com',
    'api.login.yahoo.com',
    'id.twitch.tv',
    'auth.atlassian.com',
    'accounts.spotify.com',
    'oauth.vk.com',
    'kauth.kakao.com',
    'access.line.me',
]);
const IDP_PATHS = [
    [/^(www\.)?github\.com$/, /^\/(login|session|sessions\/|login\/oauth\/)/],
    [/^(www\.|m\.|web\.)?facebook\.com$/, /^\/(v[\d.]+\/)?dialog\/oauth|^\/login/],
    [/^(www\.)?discord\.com$/, /^\/(api\/(v\d+\/)?)?oauth2\/authorize|^\/login/],
    [/^(twitter|x)\.com$/, /^\/i\/oauth2\/authorize|^\/i\/flow\/login/],
    [/^api\.(twitter|x)\.com$/, /^\/oauth\/(authorize|authenticate)/],
    [/^(www\.)?linkedin\.com$/, /^\/oauth\/|^\/uas\/login/],
    [/^(www\.)?amazon\.com$/, /^\/ap\/(signin|oa)/],
    [/^gitlab\.com$/, /^\/oauth\/authorize|^\/users\/sign_in/],
];

// An authorization request (RFC 6749 section 4.1.1 / 4.2.1, OpenID Connect Core 3.1.2.1): client_id plus response_type or
// redirect_uri in the query. Auth0, Okta, Keycloak, Cognito and a site's own provider all look like this.
function isAuthorizationRequest(u) {
    const q = u.searchParams;
    return q.has('client_id') && (q.has('response_type') || q.has('redirect_uri'));
}

function parse(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
    } catch {
        return null;
    }
}

// What the carapace knows about a sign-in page, or null when `url` is not one.
// { provider: host, redirectUri: string | null (absolute http(s)), reason: 'provider' | 'authorization request' }
// `fromUrl` is the page that asked: a site's own sign-in (open.spotify.com to accounts.spotify.com, discord.com/login on
// discord.com) is first-party and stays in Chitin; only a different site's provider is handed off.
export function detectSignIn(url, fromUrl) {
    const u = parse(url);
    if (!u)
        return null;
    const from = fromUrl && parse(fromUrl);
    if (from && siteOf(u.href) === siteOf(from.href))
        return null;
    const host = u.hostname.toLowerCase();
    let reason = null;
    if (IDP_HOSTS.has(host))
        reason = 'provider';
    else if (IDP_PATHS.some(([h, p]) => h.test(host) && p.test(u.pathname)))
        reason = 'provider';
    else if (isAuthorizationRequest(u))
        reason = 'authorization request';
    if (!reason)
        return null;
    let redirectUri = null;
    const r = u.searchParams.get('redirect_uri') || u.searchParams.get('oauth_callback');
    if (r && parse(r))
        redirectUri = parse(r).href;
    return { provider: host, redirectUri, reason };
}

// The URL a pasted address resolves to when it may be used to return to the site, else { error } in plain words.
// ctx: { siteUrl: the page that started the sign-in (the tab's page, or the popup's opener), redirectUri: from the request, or null }.
// Rules: http(s) only; the site's own site (registrable domain) only, since the return page runs in that site's segment with its
// cookies; when the request named a redirect_uri, the same origin and path (query and fragment are what the provider added).
export function checkReturnUrl(pasted, ctx) {
    const text = String(pasted || '').trim();
    if (!text)
        return { error: 'Paste the address your browser shows after signing in.' };
    if (text.length > 8192)
        return { error: 'That address is too long.' };
    const u = parse(text);
    if (!u)
        return { error: 'That is not a web address (it should start with https://).' };
    const site = siteOf(ctx.siteUrl);
    if (!site || siteOf(u.href) !== site)
        return { error: `That address is not on ${site || 'the site'}; only the site's own return page can finish its sign-in here.` };
    if (ctx.redirectUri) {
        const r = parse(ctx.redirectUri);
        if (r && (r.origin !== u.origin || r.pathname !== u.pathname))
            return { error: `The site asked the provider to return to ${r.origin}${r.pathname}; that address is a different page.` };
    }
    return { url: u.href };
}

