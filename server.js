const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');

// --- Configuration ---
const app = express();
const PORT = 3000;
const JWT_SECRET = 'your-super-secret-key-that-is-long-and-random';
const dbConfig = {
    user: 'postgres',
    host: 'localhost',
    database: 'kids_shop',
    password: 'haslo', // IMPORTANT: Use your password
    port: 5432,
};
const pool = new Pool(dbConfig);

// --- Middleware ---
app.use(cors());
app.use(express.json());

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// --- API Endpoints ---

// Product Endpoint with Pagination and Brand/Producer info
app.get('/api/products', async (req, res) => {
    try {
        const { category, page = 1, limit = 12 } = req.query;
        const offset = (page - 1) * limit;

        let countQuery = 'SELECT COUNT(*) FROM products p';
        const countParams = [];
        if (category) {
            countQuery += ' WHERE p.category_path ILIKE $1';
            countParams.push(`${category}%`);
        }
        const totalResult = await pool.query(countQuery, countParams);
        const totalProducts = parseInt(totalResult.rows[0].count, 10);
        const totalPages = Math.ceil(totalProducts / limit);

        let productsQuery = `
            SELECT p.*, b.name as brand_name, pr.name as producer_name 
            FROM products p
            LEFT JOIN brands b ON p.brand_id = b.id
            LEFT JOIN producers pr ON p.producer_id = pr.id
        `;
        const productsParams = [];
        if (category) {
            productsQuery += ' WHERE p.category_path ILIKE $1';
            productsParams.push(`${category}%`);
        }
        productsQuery += ` ORDER BY p.id ASC LIMIT $${productsParams.length + 1} OFFSET $${productsParams.length + 2}`;
        productsParams.push(limit, offset);
        
        const productsResult = await pool.query(productsQuery, productsParams);

        res.json({
            pagination: {
                totalProducts,
                totalPages,
                currentPage: parseInt(page, 10),
            },
            products: productsResult.rows
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'An internal server error occurred' });
    }
});


// Single Product Endpoint to include attributes, brand, and producer
app.get('/api/products/:sku', async (req, res) => {
    try {
        const { sku } = req.params;
        const query = `
            SELECT 
                p.*, 
                b.name as brand_name,
                pr.name as producer_name,
                COALESCE(
                    (SELECT json_agg(pa.*) FROM product_attributes pa WHERE pa.product_id = p.id),
                    '[]'
                ) as attributes
            FROM products p
            LEFT JOIN brands b ON p.brand_id = b.id
            LEFT JOIN producers pr ON p.producer_id = pr.id
            WHERE p.sku = $1;
        `;
        const result = await pool.query(query, [sku]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'An internal server error occurred' });
    }
});

// Auth Endpoints
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, first_name, last_name } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }
        const saltRounds = 10;
        const password_hash = await bcrypt.hash(password, saltRounds);
        const query = `
            INSERT INTO customers (email, password_hash, first_name, last_name) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id, email, created_at;
        `;
        const newUser = await pool.query(query, [email, password_hash, first_name, last_name]);
        res.status(201).json(newUser.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: 'A user with this email already exists.' });
        }
        console.error(err);
        res.status(500).json({ error: 'An internal server error occurred' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const userResult = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const user = userResult.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: '1h' }
        );
        res.json({ message: "Login successful", token: token });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'An internal server error occurred' });
    }
});

// Protected User Account Endpoint
app.get('/api/account/profile', authenticateToken, (req, res) => {
    res.json({
        message: "This is protected data for your profile.",
        user: req.user 
    });
});

// Shopping Cart Endpoints
app.get('/api/cart', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const query = `
            SELECT ci.product_id, ci.quantity, p.name, p.price, p.image_urls
            FROM cart_items ci
            JOIN products p ON ci.product_id = p.id
            WHERE ci.customer_id = $1;
        `;
        const { rows } = await pool.query(query, [userId]);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'An internal server error occurred' });
    }
});

app.post('/api/cart', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { productId, quantity } = req.body;
        if (!productId || !quantity || quantity < 1) {
            return res.status(400).json({ error: 'Valid productId and quantity are required.' });
        }
        const query = `
            INSERT INTO cart_items (customer_id, product_id, quantity)
            VALUES ($1, $2, $3)
            ON CONFLICT (customer_id, product_id)
            DO UPDATE SET quantity = cart_items.quantity + $3
            RETURNING *;
        `;
        const { rows } = await pool.query(query, [userId, productId, quantity]);
        res.status(200).json(rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'An internal server error occurred' });
    }
});

app.delete('/api/cart/:productId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { productId } = req.params;
        const query = 'DELETE FROM cart_items WHERE customer_id = $1 AND product_id = $2';
        await pool.query(query, [userId, productId]);
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'An internal server error occurred' });
    }
});

// Order Endpoint
app.post('/api/orders', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const userId = req.user.userId;
        const { shipping_address } = req.body;

        if (!shipping_address) {
            return res.status(400).json({ error: 'Shipping address is required.' });
        }

        await client.query('BEGIN');

        const cartQuery = `
            SELECT ci.product_id, ci.quantity, p.price
            FROM cart_items ci
            JOIN products p ON ci.product_id = p.id
            WHERE ci.customer_id = $1 FOR UPDATE;
        `;
        const cartResult = await client.query(cartQuery, [userId]);
        const cartItems = cartResult.rows;

        if (cartItems.length === 0) {
            throw new Error('Cannot create order from an empty cart.');
        }

        const totalAmount = cartItems.reduce((sum, item) => {
            return sum + (item.price * item.quantity);
        }, 0);

        const orderQuery = `
            INSERT INTO orders (customer_id, total_amount, shipping_address, status)
            VALUES ($1, $2, $3, 'pending')
            RETURNING id;
        `;
        const orderResult = await client.query(orderQuery, [userId, totalAmount, shipping_address]);
        const newOrderId = orderResult.rows[0].id;

        const orderItemsQuery = `
            INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase)
            SELECT $1, product_id, quantity, (SELECT price FROM products WHERE id = product_id)
            FROM cart_items WHERE customer_id = $2;
        `;
        await client.query(orderItemsQuery, [newOrderId, userId]);

        await client.query('DELETE FROM cart_items WHERE customer_id = $1', [userId]);

        await client.query('COMMIT');

        res.status(201).json({ message: 'Order created successfully!', orderId: newOrderId, totalAmount: totalAmount });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'An internal server error occurred', details: err.message });
    } finally {
        client.release();
    }
});

// --- Start the Server ---
app.listen(PORT, () => {
    console.log(`✅ Server is running on http://localhost:${PORT}`);
});
