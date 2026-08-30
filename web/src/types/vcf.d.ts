declare module 'vcf' {
  interface VCardData {
    version?: string
    fn?: string | VCardProperty
    n?: string | VCardProperty
    email?: string | VCardProperty | (string | VCardProperty)[]
    tel?: string | VCardProperty | (string | VCardProperty)[]
    org?: string | VCardProperty
    title?: string | VCardProperty
    [key: string]: unknown
  }

  interface VCardProperty {
    type?: string | string[]
    value?: string
    mediatype?: string
    toString(): string
  }

  class vCard {
    version?: string
    data: VCardData
    constructor()
    parse(input: string): vCard
    toJSON(): unknown[]
    toString(): string
    static parse(input: string): vCard[]
    static fromJSON(data: unknown): vCard
  }

  export = vCard
}
