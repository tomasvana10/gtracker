const extractPosFromKeyStringRegex = /\[C@(\d+,\d+,\d+)\]/;

export const sanitiseServerIdentifier = (serverIdentifier: string) =>
  serverIdentifier.replaceAll(".", "∙");

export const keyStringToPos = (string: string) =>
  string
    .match(extractPosFromKeyStringRegex)![1]
    .split(",")
    .map(coord => parseInt(coord));
