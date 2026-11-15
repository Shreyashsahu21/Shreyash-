const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { MongoClient } = require('mongodb');

require('dotenv').config();

const app = express();
// Keep the API on a dedicated port to avoid conflicts with common local services.
const PORT = Number(process.env.PORT) || 3004;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DATABASE = process.env.MONGODB_DATABASE || 'routeguard';
const REPORT_TYPES = new Set(['Accident', 'Traffic', 'Roadblock', 'Construction']);
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const OSRM_BASE = 'https://router.project-osrm.org';
const REPORTS_DATA_PATH = path.join(__dirname, 'data', 'reports.json');

let mongoClient;
let reportsCollection;

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

function cleanText(value, maximumLength) {
    return typeof value === 'string'
        ? value.trim().replace(/\s+/g, ' ').slice(0, maximumLength)
        : '';
}

function normaliseCoordinates(value) {
    if (!Array.isArray(value) || value.length !== 2) return null;

    const latitude = Number(value[0]);
    const longitude = Number(value[1]);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

    return [latitude, longitude];
}

function createReport(input = {}) {
    const type = cleanText(input.type, 40);
    const location = cleanText(input.location, 160);
    const description = cleanText(input.description, 600);
    const coordinates = normaliseCoordinates(input.coordinates);

    if (!REPORT_TYPES.has(type)) return { error: 'Choose a valid incident type.' };
    if (!location) return { error: 'Location is required.' };
    if (!description) return { error: 'Description is required.' };
    if (!coordinates) return { error: 'Valid map coordinates are required.' };

    return {
        report: {
            id: crypto.randomUUID(),
            type,
            location,
            description,
            coordinates,
            createdAt: new Date().toISOString()
        }
    };
}

async function ensureReportsDataFile() {
    await fs.mkdir(path.dirname(REPORTS_DATA_PATH), { recursive: true });

    try {
        await fs.access(REPORTS_DATA_PATH);
    } catch (error) {
        await fs.writeFile(REPORTS_DATA_PATH, '[]', 'utf8');
    }
}

async function readReportsFromFile() {
    await ensureReportsDataFile();

    const rawReports = await fs.readFile(REPORTS_DATA_PATH, 'utf8');
    try {
        const parsedReports = JSON.parse(rawReports);
        return Array.isArray(parsedReports) ? parsedReports : [];
    } catch (error) {
        await fs.writeFile(REPORTS_DATA_PATH, '[]', 'utf8');
        return [];
    }
}

async function writeReportsToFile(reports) {
    await ensureReportsDataFile();
    await fs.writeFile(REPORTS_DATA_PATH, JSON.stringify(reports, null, 2), 'utf8');
}

async function getReports() {
    if (reportsCollection) {
        return reportsCollection
            .find({}, { projection: { _id: 0 } })
            .sort({ createdAt: -1 })
            .toArray();
    }

    return readReportsFromFile();
}

function requireLocalAdmin(request, response, next) {
    const remoteAddress = (request.socket.remoteAddress || '').toLowerCase();
    const ipv4Address = remoteAddress.startsWith('::ffff:')
        ? remoteAddress.slice('::ffff:'.length)
        : remoteAddress;
    const origin = request.get('origin');
    const fetchSite = request.get('sec-fetch-site');
    const allowedOrigins = new Set([
        `http://localhost:${PORT}`,
        `http://127.0.0.1:${PORT}`,
        `http://[::1]:${PORT}`,
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://[::1]:5173',
        'http://localhost:4173',
        'http://127.0.0.1:4173',
        'http://[::1]:4173'
    ]);

    const isLoopback = remoteAddress === '::1' || /^127(?:\.\d{1,3}){3}$/.test(ipv4Address);
    const isLocalRequest = !fetchSite ||
        ['same-origin', 'same-site', 'none'].includes(fetchSite);
    if (isLoopback && isLocalRequest && (!origin || allowedOrigins.has(origin))) {
        return next();
    }

    response.status(403).json({ error: 'Report deletion is available only from this computer.' });
}

async function connectDatabase() {
    if (!MONGODB_URI) {
        throw new Error('MONGODB_URI is required. Copy .env.example to .env and set the connection string.');
    }

    mongoClient = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 5000
    });

    await mongoClient.connect();
    reportsCollection = mongoClient.db(MONGODB_DATABASE).collection('reports');
    await Promise.all([
        reportsCollection.createIndex({ id: 1 }, { unique: true }),
        reportsCollection.createIndex({ createdAt: -1 })
    ]);

    console.log(`Connected to MongoDB database: ${MONGODB_DATABASE}`);
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            Accept: 'application/json',
            'User-Agent': 'RouteGuard/1.0 (road-safety-demo)',
            ...(options.headers || {})
        }
    });

    if (!response.ok) {
        throw new Error(`External service returned HTTP ${response.status}.`);
    }

    return response.json();
}

// Health check
app.get('/api/health', (request, response) => {
    response.json({
        status: 'ok',
        service: 'RouteGuard API',
        database: reportsCollection ? 'connected' : 'local-file',
        timestamp: new Date().toISOString()
    });
});

// Geocoding: browser -> RouteGuard -> OpenStreetMap Nominatim
app.get('/api/geocode', async (request, response, next) => {
    try {
        const query = cleanText(request.query.q, 200);
        if (!query) return response.status(400).json({ error: 'Location query is required.' });

        const url = new URL('/search', NOMINATIM_BASE);
        url.search = new URLSearchParams({
            format: 'jsonv2',
            limit: '1',
            q: query
        });

        const results = await fetchJson(url);
        response.json(results);
    } catch (error) {
        next(error);
    }
});

// Reverse geocoding
app.get('/api/reverse-geocode', async (request, response, next) => {
    try {
        const latitude = Number(request.query.lat);
        const longitude = Number(request.query.lon);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
            latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
            return response.status(400).json({ error: 'Valid latitude and longitude are required.' });
        }

        const url = new URL('/reverse', NOMINATIM_BASE);
        url.search = new URLSearchParams({
            format: 'jsonv2',
            lat: String(latitude),
            lon: String(longitude)
        });

        const data = await fetchJson(url);
        response.json({
            display_name: data.display_name || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
        });
    } catch (error) {
        next(error);
    }
});

// Routing: browser -> RouteGuard -> OSRM
app.get('/api/route', async (request, response, next) => {
    try {
        const start = normaliseCoordinates([
            request.query.startLat,
            request.query.startLon
        ]);
        const end = normaliseCoordinates([
            request.query.endLat,
            request.query.endLon
        ]);

        if (!start || !end) {
            return response.status(400).json({ error: 'Valid start and destination coordinates are required.' });
        }

        if (request.query.alternatives &&
            !['initial', 'more'].includes(request.query.alternatives)) {
            return response.status(400).json({ error: 'Invalid route alternatives option.' });
        }

        const coordinates = `${start[1]},${start[0]};${end[1]},${end[0]}`;
        const url = new URL(`/route/v1/driving/${coordinates}`, OSRM_BASE);
        url.search = new URLSearchParams({
            overview: 'full',
            geometries: 'geojson',
            alternatives: request.query.alternatives === 'more' ? '3' : 'false'
        });

        const data = await fetchJson(url);
        response.json(data);
    } catch (error) {
        next(error);
    }
});

// Incident reports
app.get('/api/reports', async (request, response, next) => {
    try {
        const reports = await getReports();
        response.json({ success: true, count: reports.length, reports });
    } catch (error) {
        next(error);
    }
});

app.get('/api/reports/:id', async (request, response, next) => {
    try {
        const report = reportsCollection
            ? await reportsCollection.findOne(
                { id: request.params.id },
                { projection: { _id: 0 } }
            )
            : (await readReportsFromFile()).find(item => item.id === request.params.id) || null;

        if (!report) return response.status(404).json({ error: 'Incident report not found.' });
        response.json({ success: true, report });
    } catch (error) {
        next(error);
    }
});

app.post('/api/reports', async (request, response, next) => {
    try {
        const result = createReport(request.body);
        if (result.error) return response.status(400).json({ error: result.error });

        if (reportsCollection) {
            await reportsCollection.insertOne(result.report);
        } else {
            const reports = await readReportsFromFile();
            await writeReportsToFile([result.report, ...reports]);
        }

        response.status(201).json({ success: true, report: result.report });
    } catch (error) {
        next(error);
    }
});

app.get('/admin', (request, response) => {
    response.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/admin/reports', async (request, response, next) => {
    try {
        const reports = await getReports();
        const summary = { total: reports.length };
        REPORT_TYPES.forEach(type => {
            summary[type] = reports.filter(report => report.type === type).length;
        });

        response.json({ success: true, summary, reports });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/reports/:id', requireLocalAdmin, async (request, response, next) => {
    try {
        if (reportsCollection) {
            const deletedReport = await reportsCollection.findOneAndDelete(
                { id: request.params.id },
                { projection: { _id: 0 } }
            );

            if (!deletedReport) return response.status(404).json({ error: 'Incident report not found.' });

            response.json({ success: true, report: deletedReport });
            return;
        }

        const reports = await readReportsFromFile();
        const reportIndex = reports.findIndex(item => item.id === request.params.id);

        if (reportIndex === -1) {
            return response.status(404).json({ error: 'Incident report not found.' });
        }

        const [deletedReport] = reports.splice(reportIndex, 1);
        await writeReportsToFile(reports);
        response.json({ success: true, report: deletedReport });
    } catch (error) {
        next(error);
    }
});

// Serve the frontend and API from one origin so route search does not depend on Vite.
app.use(express.static(path.join(__dirname, '..', 'frontend'), { index: 'index.html' }));

app.use((request, response) => {
    response.status(404).json({ error: 'Route not found.' });
});

app.use((error, request, response, next) => {
    console.error(`[${new Date().toISOString()}]`, error);
    response.status(500).json({ error: 'The server could not complete that request.' });
});

async function startServer() {
    try {
        await connectDatabase();
    } catch (error) {
        console.warn(`MongoDB is unavailable; route search will still work. ${error.message}`);
    }

    app.listen(PORT, () => {
        console.log(`RouteGuard is running at http://localhost:${PORT}`);
    });
}

startServer();
