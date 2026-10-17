export interface BaseRecord {
  id: string;
  updated_at: string;
  deleted: number;
  synced: number;
}

export interface TripRecord extends BaseRecord {
  name: string;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
}

export interface CityRecord extends BaseRecord {
  trip_id: string;
  name: string;
  name_cn: string | null;
  arrive_date: string | null;
  depart_date: string | null;
  hotel_name: string | null;
  hotel_address_cn: string | null;
  sort_order: number | null;
}

export interface SupplierRecord extends BaseRecord {
  name: string;
  name_cn: string | null;
  city_id: string | null;
  address_cn: string | null;
  address_en: string | null;
  contact_name: string | null;
  contact_mobile: string | null;
  whatsapp: string | null;
  email: string | null;
  website: string | null;
  wechat_id: string | null;
  product_category: string | null;
  products: string | null;
  specialty: string | null;
  region: string | null;
  established: string | null;
  employees: string | null;
  export_markets: string | null;
  map_url: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  notes: string | null;
  priority: SupplierPriority;
  skip_reason: string;
}

export type SupplierPriority = 'MUST' | 'MAYBE' | 'SKIP';

export interface TripSupplierRecord extends BaseRecord {
  trip_id: string;
  supplier_id: string;
}

export type PlaceType = 'airport' | 'railway_station' | 'bus_station' | 'hotel';

export interface PlaceRecord extends BaseRecord {
  name: string;
  type: PlaceType;
  address: string | null;
  map_url: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  notes: string | null;
}

export type VisitStatus = 'PLANNED' | 'CONFIRMED' | 'DONE' | 'CANCELLED';

export interface VisitRecord extends BaseRecord {
  trip_id: string;
  supplier_id: string;
  visit_date: string;
  slot: string | null;
  scheduled_time: string | null;
  purpose: string | null;
  status: VisitStatus;
  confirmed_at: string | null;
  outcome_notes: string | null;
  next_action: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
}

export type UserRole = 'ADMIN' | 'MEMBER';

export interface UserRecord extends BaseRecord {
  name: string;
  email: string | null;
  role: UserRole;
  active: number;
  password_hash: string | null;
}

export type PhotoParentType = 'visit' | 'sample' | 'supplier' | 'city';

export interface PhotoRecord extends BaseRecord {
  parent_type: PhotoParentType | null;
  parent_id: string | null;
  local_path: string | null;
  server_url: string | null;
  caption: string | null;
  tag: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  taken_at: string | null;
  uploaded: number;
}

export interface SampleRecord extends BaseRecord {
  visit_id: string;
  sample_no: string | null;
  description: string | null;
  description_cn: string | null;
  qty: number | null;
  unit_price: number | null;
  currency: string | null;
  moq: number | null;
  lead_time_days: number | null;
  collected: number;
  follow_up_required: number;
  notes: string | null;
}

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    notes TEXT,
    updated_at TEXT,
    deleted INTEGER DEFAULT 0,
    synced INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS cities (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_cn TEXT,
    arrive_date TEXT,
    depart_date TEXT,
    hotel_name TEXT,
    hotel_address_cn TEXT,
    sort_order INTEGER,
    updated_at TEXT,
    deleted INTEGER DEFAULT 0,
    synced INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_cn TEXT,
    city_id TEXT,
    address_cn TEXT,
    address_en TEXT,
    contact_name TEXT,
    contact_mobile TEXT,
    whatsapp TEXT,
    email TEXT,
    website TEXT,
    wechat_id TEXT,
    product_category TEXT,
    products TEXT,
    specialty TEXT,
    region TEXT,
    established TEXT,
    employees TEXT,
    export_markets TEXT,
    map_url TEXT,
    gps_lat REAL,
    gps_lng REAL,
    notes TEXT,
    priority TEXT DEFAULT 'MAYBE',
    skip_reason TEXT DEFAULT '',
    updated_at TEXT,
    deleted INTEGER DEFAULT 0,
    synced INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS trip_suppliers (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    updated_at TEXT,
    deleted INTEGER DEFAULT 0,
    synced INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    address TEXT,
    map_url TEXT,
    gps_lat REAL,
    gps_lng REAL,
    notes TEXT,
    updated_at TEXT,
    deleted INTEGER DEFAULT 0,
    synced INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    visit_date TEXT NOT NULL,
    slot TEXT,
    scheduled_time TEXT,
    purpose TEXT,
    status TEXT DEFAULT 'PLANNED',
    confirmed_at TEXT,
    outcome_notes TEXT,
    next_action TEXT,
    gps_lat REAL,
    gps_lng REAL,
    updated_at TEXT,
    deleted INTEGER DEFAULT 0,
    synced INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS samples (
    id TEXT PRIMARY KEY,
    visit_id TEXT NOT NULL,
    sample_no TEXT,
    description TEXT,
    description_cn TEXT,
    qty REAL,
    unit_price REAL,
    currency TEXT DEFAULT 'USD',
    moq REAL,
    lead_time_days INTEGER,
    collected INTEGER DEFAULT 0,
    follow_up_required INTEGER DEFAULT 0,
    notes TEXT,
    updated_at TEXT,
    deleted INTEGER DEFAULT 0,
    synced INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    parent_type TEXT,
    parent_id TEXT,
    local_path TEXT,
    server_url TEXT,
    caption TEXT,
    tag TEXT,
    gps_lat REAL,
    gps_lng REAL,
    taken_at TEXT,
    uploaded INTEGER DEFAULT 0,
    updated_at TEXT,
    deleted INTEGER DEFAULT 0,
    synced INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'MEMBER',
    active INTEGER DEFAULT 1,
    password_hash TEXT,
    updated_at TEXT,
    deleted INTEGER DEFAULT 0,
    synced INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS pending_ops (
    id TEXT PRIMARY KEY,
    table_name TEXT,
    row_id TEXT,
    op TEXT,
    payload TEXT,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    identifier TEXT PRIMARY KEY,
    failed_count INTEGER DEFAULT 0,
    locked_until TEXT,
    last_attempt_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_visits_visit_date ON visits (visit_date)`,
  `CREATE INDEX IF NOT EXISTS idx_visits_trip_id ON visits (trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_visits_supplier_id ON visits (supplier_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trip_suppliers_trip_supplier ON trip_suppliers (trip_id, supplier_id)`,
  `CREATE INDEX IF NOT EXISTS idx_samples_visit_id ON samples (visit_id)`,
  `CREATE INDEX IF NOT EXISTS idx_photos_parent ON photos (parent_type, parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trips_synced ON trips (synced)`,
  `CREATE INDEX IF NOT EXISTS idx_cities_synced ON cities (synced)`,
  `CREATE INDEX IF NOT EXISTS idx_suppliers_synced ON suppliers (synced)`,
  `CREATE INDEX IF NOT EXISTS idx_places_synced ON places (synced)`,
  `CREATE INDEX IF NOT EXISTS idx_trip_suppliers_synced ON trip_suppliers (synced)`,
  `CREATE INDEX IF NOT EXISTS idx_visits_synced ON visits (synced)`,
  `CREATE INDEX IF NOT EXISTS idx_samples_synced ON samples (synced)`,
  `CREATE INDEX IF NOT EXISTS idx_photos_synced ON photos (synced)`,
  `CREATE INDEX IF NOT EXISTS idx_users_synced ON users (synced)`
];

// Columns added after a table already shipped. CREATE TABLE IF NOT EXISTS
// skips existing tables, so these are applied separately to upgrade old DBs.
export const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'suppliers', column: 'map_url', ddl: 'ALTER TABLE suppliers ADD COLUMN map_url TEXT' },
  { table: 'suppliers', column: 'whatsapp', ddl: 'ALTER TABLE suppliers ADD COLUMN whatsapp TEXT' },
  { table: 'suppliers', column: 'email', ddl: 'ALTER TABLE suppliers ADD COLUMN email TEXT' },
  { table: 'suppliers', column: 'website', ddl: 'ALTER TABLE suppliers ADD COLUMN website TEXT' },
  { table: 'suppliers', column: 'products', ddl: 'ALTER TABLE suppliers ADD COLUMN products TEXT' },
  { table: 'suppliers', column: 'specialty', ddl: 'ALTER TABLE suppliers ADD COLUMN specialty TEXT' },
  { table: 'suppliers', column: 'region', ddl: 'ALTER TABLE suppliers ADD COLUMN region TEXT' },
  { table: 'suppliers', column: 'established', ddl: 'ALTER TABLE suppliers ADD COLUMN established TEXT' },
  { table: 'suppliers', column: 'employees', ddl: 'ALTER TABLE suppliers ADD COLUMN employees TEXT' },
  { table: 'suppliers', column: 'export_markets', ddl: 'ALTER TABLE suppliers ADD COLUMN export_markets TEXT' },
  { table: 'suppliers', column: 'gps_lat', ddl: 'ALTER TABLE suppliers ADD COLUMN gps_lat REAL' },
  { table: 'suppliers', column: 'gps_lng', ddl: 'ALTER TABLE suppliers ADD COLUMN gps_lng REAL' },
  // SQLite fills an added column's DEFAULT into every existing row, so old suppliers become MAYBE.
  { table: 'suppliers', column: 'priority', ddl: "ALTER TABLE suppliers ADD COLUMN priority TEXT DEFAULT 'MAYBE'" },
  { table: 'suppliers', column: 'skip_reason', ddl: "ALTER TABLE suppliers ADD COLUMN skip_reason TEXT DEFAULT ''" },
  { table: 'users', column: 'password_hash', ddl: 'ALTER TABLE users ADD COLUMN password_hash TEXT' }
];
