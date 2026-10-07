/**
 * The public URL of a hero's profile photo. `version` is a short content hash: the URL changes whenever the image
 * does, so browsers/CDNs can cache it for a year, and nothing in it depends on the hero's name.
 */
export const avatarUrl = (characterId: string, version: string): string => `/api/avatars/${characterId}?v=${version}`;

/** `null` when the hero has no stored photo — the UI then draws the generated class portrait. */
export const avatarUrlOrNull = (characterId: string, version: string | null | undefined): string | null => (version ? avatarUrl(characterId, version) : null);
