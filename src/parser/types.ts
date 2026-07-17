/** Separadores leídos de MSH-1/MSH-2. Nunca asumir los valores por defecto. */
export interface Encoding {
  field: string;
  component: string;
  repetition: string;
  escape: string;
  subcomponent: string;
}

/** Hoja del AST: valores ya des-escapados. Un valor simple es subcomponents[0]. */
export interface Component {
  subcomponents: string[];
}

export interface FieldRepetition {
  components: Component[];
}

export interface Field {
  repetitions: FieldRepetition[];
}

/** `fields[i]` es SEG-(i+1). En MSH, MSH-1 es el separador de campo y MSH-2 los caracteres de encoding, ambos literales. */
export interface Segment {
  name: string;
  fields: Field[];
}

export interface Hl7Message {
  encoding: Encoding;
  segments: Segment[];
}
