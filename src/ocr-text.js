const ownershipLabelPattern = /[權徊榷罐催推檜][\s_]*利[\s_]*[範范籬][\s_]*[圍園團围]/gu;

export function normalizeOcrLabels(text) {
  return String(text ?? '').replace(ownershipLabelPattern, '權利範圍');
}
