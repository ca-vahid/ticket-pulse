/**
 * Personal API keys (4.4.05) on a /api/v1 request. Pure helpers (no imports),
 * so the v1 router can ask "is this a person?" without loading the service.
 * requireApiKey puts `req.apiKey.personal` on a request made with a `tpu_` key:
 *   { keyId, actor, abilities, keyScopes, expiresAt, readOnly, workspaceRole }
 */

export function isPersonalKeyRequest(req) {
  return Boolean(req?.apiKey?.personal?.actor);
}

/** The person the call runs as (with `via`), or null for integration keys and OAuth. */
export function personalKeyActor(req) {
  return isPersonalKeyRequest(req) ? { ...req.apiKey.personal.actor } : null;
}

/** Routes a personal key may never call: answered 403 personal_key_not_allowed_here. */
export const PERSONAL_KEY_REFUSAL = Object.freeze({
  status: 403,
  code: 'personal_key_not_allowed_here',
  title: 'Forbidden',
});

export default { isPersonalKeyRequest, personalKeyActor, PERSONAL_KEY_REFUSAL };
