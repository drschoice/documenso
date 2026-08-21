/**
 * Substitute `{token}` placeholders in user-authored email copy.
 *
 * The key pattern excludes braces as well as whitespace. A greedy `\S+` would let a single match
 * span two adjacent placeholders that aren't separated by a space — `{document.name}-{signer.name}`
 * matched as the one bogus key `document.name}-{signer.name`, which then failed the lookup and was
 * emitted with its braces stripped.
 *
 * An unknown key is emitted without its braces, which is long-standing behaviour the placeholder
 * helper shown next to the subject/message fields documents.
 */
export const renderCustomEmailTemplate = <T extends Record<string, string>>(
  template: string,
  variables: T,
): string => {
  return template.replace(/\{([^{}\s]+)\}/g, (_, key) => {
    if (key in variables) {
      return variables[key];
    }

    return key;
  });
};
