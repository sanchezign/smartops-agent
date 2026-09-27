/**
 * Fictitious but realistic demo data (phase 9): three Uruguayan hardware-store suppliers,
 * customers and staff. Every phone number is a fake 59899… number, every name invented.
 * Prices in UYU. Used by the demo seed (screenshots, video, Playwright, public demo).
 */

export interface DemoProduct {
  name: string;
  unit: string;
  price: number;
  stock?: number;
}

export interface DemoSupplier {
  key: string;
  name: string;
  waId: string;
  contactName: string;
  taxIncluded: boolean;
  products: DemoProduct[];
}

export const DEMO_SUPPLIERS: DemoSupplier[] = [
  {
    key: "norte",
    name: "Distribuidora Norte S.A.",
    waId: "59899100001",
    contactName: "Ventas Distribuidora Norte",
    taxIncluded: true,
    products: [
      { name: "Tornillo autoperforante 8x1", unit: "caja x100", price: 310, stock: 40 },
      { name: "Tornillo 6mm", unit: "unidad", price: 12, stock: 900 },
      { name: "Tuerca 6mm", unit: "unidad", price: 5, stock: 1200 },
      { name: "Arandela 6mm", unit: "unidad", price: 3, stock: 1500 },
      { name: "Tarugo 8mm x100", unit: "bolsa", price: 144, stock: 60 },
      { name: "Bisagra 3 pulgadas", unit: "par", price: 455, stock: 25 },
      { name: "Candado bronce 40mm", unit: "unidad", price: 310, stock: 18 },
      { name: "Cerradura de embutir", unit: "unidad", price: 245, stock: 12 },
      { name: "Cemento portland 25kg", unit: "bolsa", price: 420, stock: 80 },
      { name: "Arena gruesa", unit: "m3", price: 1650, stock: 9 },
      { name: "Clavo 2 pulgadas", unit: "kg", price: 138, stock: 70 },
      { name: "Alambre galvanizado 17", unit: "kg", price: 160, stock: 35 },
      { name: "Silicona transparente", unit: "cartucho", price: 190, stock: 48 },
      { name: "Cinta métrica 5m", unit: "unidad", price: 260, stock: 22 },
      { name: "Guante de nitrilo talle M", unit: "par", price: 115, stock: 150 },
      { name: "Disco de corte 115mm", unit: "unidad", price: 85, stock: 200 },
    ],
  },
  {
    key: "sur",
    name: "Pinturas del Sur",
    waId: "59899100002",
    contactName: "Pinturas del Sur",
    taxIncluded: true,
    products: [
      { name: "Pintura látex blanca 4L", unit: "balde", price: 1850, stock: 30 },
      { name: "Pintura látex blanca 20L", unit: "balde", price: 7900, stock: 8 },
      { name: "Esmalte sintético negro 1L", unit: "lata", price: 690, stock: 26 },
      { name: "Barniz marino 1L", unit: "lata", price: 820, stock: 14 },
      { name: "Rodillo lana 23cm", unit: "unidad", price: 340, stock: 40 },
      { name: "Pincel 2 pulgadas", unit: "unidad", price: 150, stock: 70 },
      { name: "Diluyente 1L", unit: "botella", price: 260, stock: 33 },
      { name: "Enduido interior 4L", unit: "balde", price: 980, stock: 17 },
      { name: "Lija al agua 180", unit: "hoja", price: 38, stock: 300 },
      { name: "Cinta de enmascarar 24mm", unit: "rollo", price: 95, stock: 120 },
    ],
  },
  {
    key: "oriental",
    name: "Eléctrica Oriental",
    waId: "59899100003",
    contactName: "Eléctrica Oriental",
    taxIncluded: false,
    products: [
      { name: "Cable 2mm", unit: "metro", price: 45, stock: 800 },
      { name: "Cable 4mm", unit: "metro", price: 78, stock: 500 },
      { name: "Lámpara LED 9W", unit: "unidad", price: 120, stock: 160 },
      { name: "Lámpara LED 15W", unit: "unidad", price: 175, stock: 90 },
      { name: "Toma corriente doble", unit: "unidad", price: 210, stock: 45 },
      { name: "Interruptor simple", unit: "unidad", price: 160, stock: 60 },
      { name: "Llave térmica 16A", unit: "unidad", price: 540, stock: 20 },
      { name: "Disyuntor diferencial 40A", unit: "unidad", price: 2850, stock: 6 },
      { name: "Caño corrugado 3/4", unit: "rollo 25m", price: 690, stock: 15 },
      { name: "Cinta aisladora 20m", unit: "unidad", price: 100, stock: 140 },
      { name: "Zapatilla 5 tomas", unit: "unidad", price: 680, stock: 24 },
      { name: "Tanza para bordeadora 2mm", unit: "rollo", price: 210, stock: 3 },
    ],
  },
];

export interface DemoCustomer {
  waId: string;
  name: string;
  kind: "customer" | "internal";
}

export const DEMO_CUSTOMERS: DemoCustomer[] = [
  { waId: "59899200001", name: "Ana Pereira", kind: "customer" },
  { waId: "59899200002", name: "Luis Fernández", kind: "customer" },
  { waId: "59899200003", name: "Marta Silva", kind: "customer" },
  { waId: "59899200004", name: "Jorge Rodríguez", kind: "customer" },
  { waId: "59899200005", name: "Carolina (depósito)", kind: "internal" },
];

/** Customer messages: [customer index, text, "query" | "order", days ago]. */
export const DEMO_CUSTOMER_MESSAGES: [number, string, "query" | "order", number][] = [
  [0, "¿Tienen candados de 40mm? ¿Qué precio tienen?", "query", 12],
  [1, "Necesito 3 macetas grandes para el sábado", "order", 9],
  [2, "¿Hasta qué hora abren el sábado?", "query", 6],
  [3, "Mandame 10 rollos de cinta aisladora, por favor", "order", 4],
  [0, "Quisiera encargar 2 baldes de látex de 20L", "order", 2],
  [1, "¿Tienen disyuntores de 40A en stock?", "query", 1],
  [4, "Necesito que me reserven 5 bolsas de portland para mañana", "order", 0],
];

/** Chit-chat that the deterministic pre-filter keeps away from the LLM. */
export const DEMO_CHITCHAT = ["hola", "gracias!!", "ok", "👍", "buen día", "dale, te aviso"];

/**
 * Distribuidora Norte's spreadsheet (a format never approved): the column_mapping review of
 * the demo. Four price columns → a person chooses (phase 9 M2). Values like a real list.
 */
export const DEMO_NORTE_SHEET: { name: string; rows: (string | number | null)[][] } = {
  name: "Lista",
  rows: [
    ["DISTRIBUIDORA NORTE S.A. - LISTA DE PRECIOS", null, null, null, null, null, null],
    ["Precios en pesos uruguayos", null, null, null, null, null, null],
    ["Código", "Descripción", "Unidad", "Precio s/IVA", "Precio c/IVA", "Mayorista", "Contado"],
    ["SEGURIDAD", null, null, null, null, null, null],
    ["CAN-040", "Candado bronce 40mm", "unidad", 262.3, 320, 238, 304],
    ["CER-001", "Cerradura de embutir", "unidad", 209.84, 256, 191, 243],
    ["HERRAJES", null, null, null, null, null, null],
    ["BIS-003", "Bisagra 3 pulgadas", "par", 385.25, 470, 350, 446],
    ["TAR-008", "Tarugo 8mm x100", "bolsa", 122.95, 150, 112, 142],
    ["ELECTRICIDAD", null, null, null, null, null, null],
    ["GUA-00M", "Guante de nitrilo talle M", "par", 97.54, 119, 89, 113],
  ],
};

/** What the column mapper (LLM) answers for that sheet (same shape as its golden output). */
export const DEMO_NORTE_SHEET_MAPPER = {
  table: "T1",
  isPriceTable: true,
  headerRow: 2,
  nameColumn: 1,
  unitColumn: 2,
  skuColumn: 0,
  currencyColumn: null,
  stockColumn: null,
  availableColumn: null,
  pctColumn: null,
  priceColumns: [
    { column: 3, header: "Precio s/IVA", taxIncluded: false, kind: "list" as const },
    { column: 4, header: "Precio c/IVA", taxIncluded: true, kind: "list" as const },
    { column: 5, header: "Mayorista", taxIncluded: null, kind: "wholesale" as const },
    { column: 6, header: "Contado", taxIncluded: null, kind: "cash" as const },
  ],
  recommendedPriceColumn: 4,
  priceFormat: "decimal_dot" as const,
  currency: "UYU",
  confidence: "high" as const,
};

/**
 * Senders of the "Probar el sistema" buttons (phase 9 M8). Their suppliers are seeded so the
 * recorded LLM outputs line up with the catalog:
 * - demo: the September PDF catalog (7 products, the photo / voice goldens refer to it);
 * - ejemplo: its spreadsheet format ALREADY APPROVED (fast $0 path, no mapper call);
 * - mayorista: no approved format (the same spreadsheet goes to the column review).
 */
export const DEMO_SAMPLE_SENDERS = {
  demo: {
    waId: "59899400001",
    contactName: "Distribuidora Demo",
    supplierName: "Distribuidora Demo S.A.",
  },
  ejemplo: {
    waId: "59899400002",
    contactName: "Distribuidora Ejemplo",
    supplierName: "Distribuidora Ejemplo S.R.L.",
  },
  mayorista: {
    waId: "59899400003",
    contactName: "Mayorista del Este",
    supplierName: "Mayorista del Este",
  },
} as const;
