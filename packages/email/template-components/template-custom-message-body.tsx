import React from 'react';

export type TemplateCustomMessageBodyProps = {
  text?: string;

  /**
   * Applied to every emitted paragraph so each template can match the spacing of the built-in copy
   * it sits next to. Renders its own `<p>` elements, so it must be placed as a sibling of `<Text>`
   * rather than inside one — `<Text>` is itself a `<p>`, and email clients handle nested paragraphs
   * inconsistently.
   */
  className?: string;
};

export const TemplateCustomMessageBody = ({
  text,
  className = 'mt-2 text-base text-slate-400',
}: TemplateCustomMessageBodyProps) => {
  if (!text) {
    return null;
  }

  const normalized = text
    .trim()
    .replace(/\r\n?/g, '\n')
    .replace(/\n\s*\n+/g, '\n\n')
    .replace(/\n{2,}/g, '\n\n');

  const paragraphs = normalized.split('\n\n');

  return paragraphs.map((paragraph, i) => (
    <p key={`p-${i}`} className={`whitespace-pre-line break-words font-sans ${className}`}>
      {paragraph.split('\n').map((line, j) => (
        <React.Fragment key={`line-${i}-${j}`}>
          {j > 0 && <br />}
          {line}
        </React.Fragment>
      ))}
    </p>
  ));
};

export default TemplateCustomMessageBody;
