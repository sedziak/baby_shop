

const { Pool } = require('pg');
const { parseStringPromise } = require('xml2js');
const axios = require('axios');

// --- Konfiguracja ---
// W przyszłości możesz podać tutaj link do nowego pliku XML
const XML_URL = 'https://www.multistore.pl/xml-porownywarki/goodhome/hurt.php?hash=jiejifev'; 


const dbConfig = {
    user: 'postgres',
    host: 'localhost',
    database: 'kids_shop',
    password: 'haslo', // WAŻNE: Wpisz swoje hasło do PostgreSQL
    port: 5432,
};

// Funkcja pomocnicza do bezpiecznego pobierania wartości z obiektu XML
const getValue = (obj, def = null) => {
    if (obj && obj[0]) {
        // Sprawdza, czy wartość to obiekt z polem '_', co jest typowe dla CDATA
        if (typeof obj[0] === 'object' && obj[0]._) {
            return obj[0]._.trim();
        }
        return obj[0].trim();
    }
    return def;
};

// Funkcja do wstawiania lub aktualizowania i pobierania ID
async function getOrCreateId(client, tableName, name) {
    if (!name) return null;
    // Sprawdź, czy już istnieje
    let res = await client.query(`SELECT id FROM ${tableName} WHERE name = $1`, [name]);
    if (res.rows.length > 0) {
        return res.rows[0].id;
    }
    // Jeśli nie, stwórz nowy
    res = await client.query(`INSERT INTO ${tableName} (name) VALUES ($1) RETURNING id`, [name]);
    return res.rows[0].id;
}


async function importData() {
    const pool = new Pool(dbConfig);
    let client;

    try {
        // Zamiast pobierać z URL, użyjemy na razie przykładowego pliku
        // W przyszłości odkomentuj poniższe linie, aby pobierać dane na żywo
        // console.log(`Pobieranie pliku XML z ${XML_URL}...`);
        // const response = await axios.get(XML_URL);
        // const xmlData = response.data;
        
        // Użyjemy przykładowych danych, które podałeś
        const fs = require('fs');
        const xmlData = fs.readFileSync('sample.xml', 'utf8'); // Upewnij się, że masz plik sample.xml z danymi
        console.log('✅ Plik XML wczytany pomyślnie.');


        client = await pool.connect();
        console.log('✅ Połączono z bazą danych.');

        const result = await parseStringPromise(xmlData, { explicitArray: true });
        
        const producersData = result.Document.responsibleProducers[0].p;
        const productsData = result.Document.Produkt;

        console.log(`Znaleziono ${producersData.length} producentów.`);
        console.log(`Znaleziono ${productsData.length} produktów.`);

        // Krok 1: Zaimportuj wszystkich producentów
        const producerMap = new Map();
        for (const producer of producersData) {
            const name = getValue(producer.name);
            if (!name) continue;

            const query = `
                INSERT INTO producers (name, country_code, street, postal_code, city, email, phone_number)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (name) DO UPDATE SET
                    country_code = EXCLUDED.country_code,
                    street = EXCLUDED.street,
                    postal_code = EXCLUDED.postal_code,
                    city = EXCLUDED.city,
                    email = EXCLUDED.email,
                    phone_number = EXCLUDED.phone_number
                RETURNING id;
            `;
            const values = [
                name,
                getValue(producer.address[0].countryCode),
                getValue(producer.address[0].street),
                getValue(producer.address[0].postalCode),
                getValue(producer.address[0].city),
                getValue(producer.contact[0].email),
                getValue(producer.contact[0].phoneNumber)
            ];
            const res = await client.query(query, values);
            producerMap.set(name, res.rows[0].id);
        }
        console.log('✅ Producenci zaimportowani.');

        // Krok 2: Zaimportuj wszystkie produkty
        for (const product of productsData) {
            const brandName = getValue(product.Marka);
            
            // POPRAWKA: Sprawdzamy, czy product.a istnieje, zanim go użyjemy
            let producerName = null;
            if (product.a) {
                const producerTag = product.a.find(a => a.$ && a.$.name === "Producent odpowiedzialny");
                if (producerTag) {
                    producerName = getValue([producerTag]);
                }
            }

            const brandId = await getOrCreateId(client, 'brands', brandName);
            const producerId = producerMap.get(producerName);
            
            // Sprawdzamy, czy linki do zdjęć istnieją
            const imageLinks = product.linki_do_zdjec && product.linki_do_zdjec[0] && product.linki_do_zdjec[0].link_do_zdjecia 
                ? product.linki_do_zdjec[0].link_do_zdjecia.join(' ') 
                : '';

            const vatString = getValue(product.Vat, '0%');
            const vat = parseInt(vatString.replace('%', ''));

            const productQuery = `
                INSERT INTO products (
                    sku, name, ean, description, price, suggested_price, vat, stock_quantity, 
                    package_length, package_width, package_height, gross_weight, 
                    image_urls, category_path, brand_id, producer_id
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
                ) ON CONFLICT (sku) DO UPDATE SET
                    name = EXCLUDED.name,
                    ean = EXCLUDED.ean,
                    description = EXCLUDED.description,
                    price = EXCLUDED.price,
                    suggested_price = EXCLUDED.suggested_price,
                    vat = EXCLUDED.vat,
                    stock_quantity = EXCLUDED.stock_quantity,
                    package_length = EXCLUDED.package_length,
                    package_width = EXCLUDED.package_width,
                    package_height = EXCLUDED.package_height,
                    gross_weight = EXCLUDED.gross_weight,
                    image_urls = EXCLUDED.image_urls,
                    category_path = EXCLUDED.category_path,
                    brand_id = EXCLUDED.brand_id,
                    producer_id = EXCLUDED.producer_id;
            `;

            const values = [
                getValue(product.Indeks), // Używamy 'Indeks' jako SKU
                getValue(product.Nazwa),
                getValue(product.Ean),
                getValue(product.opis),
                parseFloat(getValue(product.Cena_z_cennika, '0')),
                parseFloat(getValue(product.Cena_z_sugerowana, '0')),
                vat,
                parseInt(getValue(product.Stan_mag, '0')),
                parseFloat(getValue(product.Szt_dlugosc_opakowania, '0')),
                parseFloat(getValue(product.Szt_szerokosc_opakowania, '0')),
                parseFloat(getValue(product.Szt_wysokosc_opakowania, '0')),
                parseFloat(getValue(product.Szt_waga_brutto, '0')),
                imageLinks,
                getValue(product.Kategoria),
                brandId,
                producerId
            ];

            await client.query(productQuery, values);
        }
        console.log('✅ Produkty zaimportowane.');

    } catch (error) {
        console.error('❌ Wystąpił błąd podczas importu:', error);
    } finally {
        if (client) {
            client.release();
            await pool.end();
            console.log('Połączenie z bazą danych zostało zamknięte.');
        }
    }
}

importData();
