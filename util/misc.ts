export const sanitiseServerIdentifier = (serverIdentifier: string) =>
  serverIdentifier.replaceAll(".", "∙");
