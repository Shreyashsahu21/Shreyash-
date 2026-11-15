/* RouteGuard interactive map and incident reporting */

const DEFAULT_LOCATION = [21.2514, 81.6296];
const DEFAULT_ZOOM = 13;
const SAVED_ROUTE_KEY = 'routeguard.saved-route.v1';
// Use the app's origin when served by the backend or Vite; local previews use the backend directly.
const hostname = window.location.hostname.toLowerCase();
const isPrivateIPv4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
const isLocalHost = hostname === 'localhost' || hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) || isPrivateIPv4;
const isFilePage = window.location.protocol === 'file:';
const hasApiProxy = ['5173', '4173'].includes(window.location.port) ||
    (isLocalHost && /^30\d{2}$/.test(window.location.port));
const API_ORIGIN = isFilePage || (isLocalHost && !hasApiProxy)
    ? `http://${hostname || 'localhost'}:3004`
    : window.location.origin;
const API_BASE_URL = `${API_ORIGIN}/api`;
const ADMIN_URL = `${API_ORIGIN}/admin`;

document.querySelectorAll('a[href="/admin"]').forEach(function (link) {
    link.href = ADMIN_URL;
});

async function fetchApi(url, options) {
    try {
        return await fetch(url, options);
    } catch (error) {
        if (error instanceof TypeError) {
            throw new Error('Cannot reach the RouteGuard API. Start RouteGuard.bat and open the RouteGuard address it launches.');
        }
        throw error;
    }
}

const map = L.map('map', { zoomControl: true }).setView(DEFAULT_LOCATION, DEFAULT_ZOOM);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const incidents = {
    accident: {
        name: 'Road Accident',
        location: 'Main Road, Raipur',
        coordinates: [21.2570, 81.6330],
        color: '#e53935',
        icon: '⚠️',
        description: 'Accident reported near the main intersection. Traffic may be slow.'
    },
    traffic: {
        name: 'Heavy Traffic',
        location: 'City Center, Raipur',
        coordinates: [21.2500, 81.6200],
        color: '#ff9800',
        icon: '🚗',
        description: 'Heavy traffic has been reported in this area.'
    },
    roadblock: {
        name: 'Road Construction',
        location: 'Ring Road, Raipur',
        coordinates: [21.2400, 81.6450],
        color: '#7e57c2',
        icon: '🚧',
        description: 'Construction work is blocking one side of the road.'
    }
};

const reportStyles = {
    Accident: {
        title: 'Road Accident', color: '#e53935', icon: '⚠️',
        cardClass: 'accident', severityClass: 'high', severity: 'High Impact'
    },
    Traffic: {
        title: 'Heavy Traffic', color: '#ff9800', icon: '🚗',
        cardClass: 'traffic', severityClass: 'medium', severity: 'Medium Impact'
    },
    Roadblock: {
        title: 'Roadblock', color: '#7e57c2', icon: '🚧',
        cardClass: 'blockage', severityClass: 'low', severity: 'Low Impact'
    },
    Construction: {
        title: 'Road Construction', color: '#7e57c2', icon: '🚧',
        cardClass: 'blockage', severityClass: 'low', severity: 'Low Impact'
    }
};

const incidentMarkers = {};
const reportedMarkers = {};
let reportedIncidents = [];
let sourceCoordinates = null;
let destinationCoordinates = null;
let sourceMarker = null;
let destinationMarker = null;
let routeLines = [];
let routeAlternatives = [];
let selectedRouteIndex = 0;
let moreRoutesExhausted = false;
let restoredSavedRoute = false;

function escapeHTML(value) {
    const element = document.createElement('div');
    element.textContent = String(value || '');
    return element.innerHTML;
}

function createMarkerIcon(color, icon) {
    return L.divIcon({
        className: 'routeguard-marker',
        html: '<div style="width:38px;height:38px;background:' + color + ';border:3px solid #fff;border-radius:50% 50% 50% 0;box-shadow:0 4px 12px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;transform:rotate(-45deg)"><span style="font-size:17px;transform:rotate(45deg)">' + icon + '</span></div>',
        iconSize: [38, 38],
        iconAnchor: [19, 38],
        popupAnchor: [0, -38]
    });
}

function popupContent(title, icon, location, description) {
    return '<div class="routeguard-popup">' +
        '<h3>' + icon + ' ' + escapeHTML(title) + '</h3>' +
        '<p><strong>📍 ' + escapeHTML(location) + '</strong></p>' +
        '<p>' + escapeHTML(description) + '</p>' +
        '</div>';
}

function setMapStatus(message) {
    const status = document.querySelector('.map-status');
    if (status) status.innerHTML = '<span></span>' + escapeHTML(message);
}

function setRouteButtonLoading(isLoading) {
    const button = document.querySelector('.find-btn');
    if (!button) return;
    button.disabled = isLoading;
    button.textContent = isLoading ? 'Finding route…' : 'Find Safe Route →';
}

function setReportButtonLoading(isLoading) {
    const button = document.querySelector('#reportModal .submit-btn');
    if (!button) return;
    button.disabled = isLoading;
    button.textContent = isLoading ? 'Adding incident…' : 'Submit Report';
}

function removeLayer(layer) {
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
}

function saveUserRoute() {
    if (!sourceCoordinates || !destinationCoordinates) return;

    try {
        localStorage.setItem(SAVED_ROUTE_KEY, JSON.stringify({
            version: 1,
            sourceCoordinates,
            destinationCoordinates,
            sourceLabel: document.getElementById('source').value,
            destinationLabel: document.getElementById('destination').value,
            routeAlternatives,
            selectedRouteIndex
        }));
    } catch (error) {
        console.error('Could not save the current route in this browser.', error);
        setMapStatus('Route shown, but this browser could not save it for next time.');
    }
}

function isValidCoordinates(coordinates) {
    return Array.isArray(coordinates) && coordinates.length === 2 &&
        Number.isFinite(coordinates[0]) && coordinates[0] >= -90 && coordinates[0] <= 90 &&
        Number.isFinite(coordinates[1]) && coordinates[1] >= -180 && coordinates[1] <= 180;
}

function isValidSavedRoute(route) {
    return route && Number.isFinite(route.distance) && Number.isFinite(route.duration) &&
        route.geometry && Array.isArray(route.geometry.coordinates) &&
        route.geometry.coordinates.length > 1 &&
        route.geometry.coordinates.every(function (point) {
            return Array.isArray(point) && point.length === 2 &&
                Number.isFinite(point[0]) && point[0] >= -180 && point[0] <= 180 &&
                Number.isFinite(point[1]) && point[1] >= -90 && point[1] <= 90;
        });
}

function restoreSavedRoute() {
    let savedRoute;
    try {
        const serializedRoute = localStorage.getItem(SAVED_ROUTE_KEY);
        if (!serializedRoute) return false;
        savedRoute = JSON.parse(serializedRoute);
    } catch (error) {
        console.error('Could not read the saved route from this browser.', error);
        return false;
    }

    if (!savedRoute || savedRoute.version !== 1 ||
        !isValidCoordinates(savedRoute.sourceCoordinates) ||
        !isValidCoordinates(savedRoute.destinationCoordinates) ||
        typeof savedRoute.sourceLabel !== 'string' ||
        typeof savedRoute.destinationLabel !== 'string' ||
        !Array.isArray(savedRoute.routeAlternatives) ||
        !savedRoute.routeAlternatives.every(isValidSavedRoute)) {
        console.warn('The saved route is invalid and will not be restored.');
        try {
            localStorage.removeItem(SAVED_ROUTE_KEY);
        } catch (error) {
            console.error('Could not remove the invalid saved route.', error);
        }
        return false;
    }

    sourceCoordinates = savedRoute.sourceCoordinates;
    destinationCoordinates = savedRoute.destinationCoordinates;
    setInputValue('source', savedRoute.sourceLabel);
    setInputValue('destination', savedRoute.destinationLabel);
    setEndpoint('source', sourceCoordinates, savedRoute.sourceLabel);
    setEndpoint('destination', destinationCoordinates, savedRoute.destinationLabel);
    routeAlternatives = savedRoute.routeAlternatives;
    selectedRouteIndex = Math.min(
        Math.max(0, Number.isInteger(savedRoute.selectedRouteIndex) ? savedRoute.selectedRouteIndex : 0),
        Math.max(0, routeAlternatives.length - 1)
    );

    if (routeAlternatives.length) {
        renderRouteLines();
        renderRouteOptions();
        fitRouteBounds(routeCoordinates(routeAlternatives[selectedRouteIndex]));
        const route = routeAlternatives[selectedRouteIndex];
        setMapStatus(`${routeLabel(selectedRouteIndex)} restored · ${formatDistance(route.distance)} · ${formatDuration(route.duration)}`);
    } else {
        routeLines = [L.polyline([sourceCoordinates, destinationCoordinates], {
            color: '#1769ff', weight: 6, opacity: 0.8, dashArray: '10 8'
        }).addTo(map)];
        fitRouteBounds([sourceCoordinates, destinationCoordinates]);
        setMapStatus('Your last route was restored as a direct line.');
    }

    restoredSavedRoute = true;
    return true;
}

function clearRoutePresentation() {
    routeLines.forEach(removeLayer);
    routeLines = [];
    routeAlternatives = [];
    selectedRouteIndex = 0;
    moreRoutesExhausted = false;

    const moreRoutesButton = document.getElementById('load-more-routes');
    if (moreRoutesButton) {
        moreRoutesButton.disabled = false;
        moreRoutesButton.textContent = 'Find more routes';
    }

    const options = document.getElementById('route-options');
    const list = document.getElementById('route-options-list');
    if (list) list.replaceChildren();
    if (options) options.hidden = true;
}

function clearUserRoute() {
    removeLayer(sourceMarker);
    removeLayer(destinationMarker);
    clearRoutePresentation();
    sourceCoordinates = null;
    destinationCoordinates = null;
    sourceMarker = null;
    destinationMarker = null;
    try {
        localStorage.removeItem(SAVED_ROUTE_KEY);
    } catch (error) {
        console.error('Could not clear the previously saved route.', error);
    }
}

function setInputValue(id, value) {
    const input = document.getElementById(id);
    if (input) input.value = value;
}

function setEndpoint(kind, coordinates, label) {
    const isSource = kind === 'source';
    removeLayer(isSource ? sourceMarker : destinationMarker);

    const marker = L.marker(coordinates, {
        icon: createMarkerIcon(isSource ? '#1769ff' : '#14804a', isSource ? '📍' : '🏁')
    }).addTo(map).bindPopup(
        '<strong>' + (isSource ? 'Starting point' : 'Destination') + '</strong><br>' + escapeHTML(label)
    );

    if (isSource) {
        sourceCoordinates = coordinates;
        sourceMarker = marker;
    } else {
        destinationCoordinates = coordinates;
        destinationMarker = marker;
    }
    return marker;
}

function formatDistance(meters) {
    return meters >= 1000 ? (meters / 1000).toFixed(1) + ' km' : Math.round(meters) + ' m';
}

function formatDuration(seconds) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return minutes >= 60 ? Math.floor(minutes / 60) + ' hr ' + (minutes % 60) + ' min' : minutes + ' min';
}

function fitRouteBounds(points) {
    map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 15 });
}

function routeCoordinates(route) {
    return route.geometry.coordinates.map(function (point) {
        return [point[1], point[0]];
    });
}

function renderRouteLines() {
    routeLines.forEach(removeLayer);
    routeLines = routeAlternatives.map(function (route, index) {
        return L.polyline(routeCoordinates(route), {
            color: index === selectedRouteIndex ? '#1769ff' : '#7f8da3',
            weight: index === selectedRouteIndex ? 6 : 4,
            opacity: index === selectedRouteIndex ? 0.9 : 0.5,
            lineJoin: 'round',
            dashArray: index === selectedRouteIndex ? null : '8 7'
        }).addTo(map);
    });
}

function routeLabel(index) {
    return index === 0 ? 'Recommended route' : `Alternative ${index}`;
}

function renderRouteOptions() {
    const options = document.getElementById('route-options');
    const summary = document.getElementById('route-options-summary');
    const list = document.getElementById('route-options-list');
    if (!options || !summary || !list) return;

    if (!routeAlternatives.length) {
        options.hidden = true;
        return;
    }

    summary.textContent = `${routeAlternatives.length} option${routeAlternatives.length === 1 ? '' : 's'} found`;
    list.replaceChildren();
    routeAlternatives.forEach(function (route, index) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'route-option' + (index === selectedRouteIndex ? ' is-selected' : '');
        button.setAttribute('aria-pressed', String(index === selectedRouteIndex));
        button.innerHTML =
            '<span class="route-option-title">' + escapeHTML(routeLabel(index)) + '</span>' +
            '<span class="route-option-details">' +
            '<strong>' + escapeHTML(formatDuration(route.duration)) + '</strong>' +
            '<span>' + escapeHTML(formatDistance(route.distance)) + '</span>' +
            '</span>';
        button.addEventListener('click', function () {
            selectRoute(index);
        });
        list.append(button);
    });
    options.hidden = false;
}

function selectRoute(index) {
    const route = routeAlternatives[index];
    if (!route) return;

    selectedRouteIndex = index;
    renderRouteLines();
    renderRouteOptions();
    fitRouteBounds(routeCoordinates(route));
    setMapStatus(`${routeLabel(index)} selected · ${formatDistance(route.distance)} · ${formatDuration(route.duration)}`);
    saveUserRoute();
}

async function requestRouteAlternatives(mode) {
    const url = new URL(`${API_BASE_URL}/route`);
    url.searchParams.set('startLat', String(sourceCoordinates[0]));
    url.searchParams.set('startLon', String(sourceCoordinates[1]));
    url.searchParams.set('endLat', String(destinationCoordinates[0]));
    url.searchParams.set('endLon', String(destinationCoordinates[1]));
    if (mode === 'more') url.searchParams.set('alternatives', 'more');

    const response = await fetchApi(url);
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || 'Routing service failed.');
    if (data.code !== 'Ok' || !Array.isArray(data.routes) || !data.routes.length) {
        throw new Error('No road route was found.');
    }

    const routes = data.routes.filter(function (route) {
        return Array.isArray(route.geometry && route.geometry.coordinates) &&
            route.geometry.coordinates.length > 1 &&
            Number.isFinite(route.distance) &&
            Number.isFinite(route.duration);
    });

    if (!routes.length) throw new Error('No road route was found.');
    return routes;
}

async function loadMoreRoutes() {
    const button = document.getElementById('load-more-routes');
    if (!button || moreRoutesExhausted || !sourceCoordinates || !destinationCoordinates) return;

    button.disabled = true;
    button.textContent = 'Finding more routes…';
    setMapStatus('Searching for more route options…');

    try {
        const routes = await requestRouteAlternatives('more');
        const existingRoutes = new Set(routeAlternatives.map(function (route) {
            return JSON.stringify(route.geometry.coordinates);
        }));
        const newRoutes = routes.filter(function (route) {
            return !existingRoutes.has(JSON.stringify(route.geometry.coordinates));
        });

        if (!newRoutes.length) {
            moreRoutesExhausted = true;
            button.textContent = 'No more routes available';
            setMapStatus('No additional route options were found.');
            return;
        }

        routeAlternatives = routeAlternatives.concat(newRoutes);
        renderRouteLines();
        renderRouteOptions();
        setMapStatus(`${newRoutes.length} more route option${newRoutes.length === 1 ? '' : 's'} added.`);
        saveUserRoute();
    } catch (error) {
        console.error(error);
        setMapStatus(error.message || 'Could not load more route options. Please try again.');
    } finally {
        if (!moreRoutesExhausted) {
            button.disabled = false;
            button.textContent = 'Find more routes';
        }
    }
}

function addIncidentMarkers() {
    Object.keys(incidents).forEach(function (type) {
        const incident = incidents[type];
        const marker = L.marker(incident.coordinates, {
            icon: createMarkerIcon(incident.color, incident.icon)
        }).addTo(map).bindPopup(
            popupContent(incident.name, incident.icon, incident.location, incident.description)
        );
        incidentMarkers[type] = marker;
    });
}

async function loadReportedIncidents() {
    try {
        const response = await fetchApi(`${API_BASE_URL}/reports`);
        if (!response.ok) throw new Error('Could not load incident reports.');

        const data = await response.json();
        if (!data.success || !Array.isArray(data.reports)) {
            throw new Error(data.error || 'Invalid report data received.');
        }

        reportedIncidents = data.reports;
        renderReportedIncidents();
    } catch (error) {
        console.warn('Could not load incident reports from the server.', error);
        setMapStatus('Incident reports could not be loaded right now.');
    }
}

function getReportStyle(type) {
    return reportStyles[type] || reportStyles.Roadblock;
}

function addReportedIncidentMarker(report) {
    const style = getReportStyle(report.type);
    const marker = L.marker(report.coordinates, {
        icon: createMarkerIcon(style.color, style.icon)
    }).addTo(map).bindPopup(
        popupContent(style.title, style.icon, report.location, report.description)
    );

    reportedMarkers[report.id] = marker;
    return marker;
}

function appendReportedIncidentCard(report) {
    const grid = document.querySelector('.incident-grid');
    if (!grid || document.getElementById('reported-' + report.id)) return;

    const style = getReportStyle(report.type);
    const card = document.createElement('article');
    card.className = 'incident-card';
    card.id = 'reported-' + report.id;
    card.innerHTML =
        '<div class="incident-top">' +
        '<span class="incident-type ' + style.cardClass + '">' + style.icon + ' ' + escapeHTML(report.type) + '</span>' +
        '<span class="time">Just now</span>' +
        '</div>' +
        '<h3>' + escapeHTML(style.title) + '</h3>' +
        '<p class="location">📍 ' + escapeHTML(report.location) + '</p>' +
        '<p>' + escapeHTML(report.description) + '</p>' +
        '<div class="card-footer">' +
        '<span class="severity ' + style.severityClass + '">' + style.severity + '</span>' +
        '<button type="button">View →</button>' +
        '</div>';

    card.querySelector('button').addEventListener('click', function () {
        focusReportedIncident(report.id);
    });
    grid.prepend(card);
}

function renderReportedIncidents() {
    reportedIncidents.slice().reverse().forEach(function (report) {
        addReportedIncidentMarker(report);
        appendReportedIncidentCard(report);
    });
}

function focusReportedIncident(id) {
    const report = reportedIncidents.find(function (item) {
        return item.id === id;
    });
    const marker = reportedMarkers[id];
    if (!report || !marker) return;

    map.flyTo(report.coordinates, 16, { duration: 0.8 });
    marker.openPopup();
    setMapStatus('Showing your ' + report.type.toLowerCase() + ' report.');
    document.getElementById('map-section').scrollIntoView({ behavior: 'smooth' });
}

async function geocodeLocation(query) {
    const url = new URL(`${API_BASE_URL}/geocode`);
    url.searchParams.set('q', query);

    const response = await fetchApi(url);
    if (!response.ok) {
        const data = await response.json().catch(function () { return {}; });
        throw new Error(data.error || 'Location lookup failed.');
    }

    const results = await response.json();
    return results.length ? results[0] : null;
}

async function reverseGeocode(coordinates) {
    const url = new URL(`${API_BASE_URL}/reverse-geocode`);
    url.searchParams.set('lat', String(coordinates[0]));
    url.searchParams.set('lon', String(coordinates[1]));

    const response = await fetchApi(url);
    if (!response.ok) {
        const data = await response.json().catch(function () { return {}; });
        throw new Error(data.error || 'Reverse geocoding failed.');
    }

    const data = await response.json();
    return data.display_name || coordinates[0].toFixed(5) + ', ' + coordinates[1].toFixed(5);
}

async function drawRoute() {
    if (!sourceCoordinates || !destinationCoordinates) return;

    clearRoutePresentation();
    setMapStatus('Finding the road route…');

    try {
        routeAlternatives = await requestRouteAlternatives('initial');
        selectedRouteIndex = 0;
        renderRouteLines();
        renderRouteOptions();
        const route = routeAlternatives[selectedRouteIndex];
        fitRouteBounds(routeCoordinates(route));
        sourceMarker.openPopup();
        setMapStatus(`${routeAlternatives.length} route option${routeAlternatives.length === 1 ? '' : 's'} available · ${formatDistance(route.distance)} · ${formatDuration(route.duration)}`);
        saveUserRoute();
    } catch (error) {
        console.warn('Road routing is unavailable; showing a direct line.', error);
        routeLines = [L.polyline([sourceCoordinates, destinationCoordinates], {
            color: '#1769ff', weight: 6, opacity: 0.8, dashArray: '10 8'
        }).addTo(map)];
        fitRouteBounds([sourceCoordinates, destinationCoordinates]);
        setMapStatus('Direct route shown — road routing is temporarily unavailable.');
        saveUserRoute();
    }
}

async function findRoute() {
    const source = document.getElementById('source').value.trim();
    const destination = document.getElementById('destination').value.trim();

    if (!source || !destination) {
        setMapStatus('Add both a starting point and destination.');
        return;
    }

    setRouteButtonLoading(true);
    setMapStatus('Locating your route…');

    try {
        const locations = await Promise.all([
            geocodeLocation(source),
            geocodeLocation(destination)
        ]);
        if (!locations[0] || !locations[1]) {
            throw new Error('Use a more specific location name.');
        }

        const start = [parseFloat(locations[0].lat), parseFloat(locations[0].lon)];
        const end = [parseFloat(locations[1].lat), parseFloat(locations[1].lon)];
        clearUserRoute();
        setEndpoint('source', start, source);
        setEndpoint('destination', end, destination);
        fitRouteBounds([start, end]);
        document.getElementById('map-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
        await drawRoute();
    } catch (error) {
        console.error(error);
        setMapStatus(error.message || 'Could not find that route. Try another location.');
    } finally {
        setRouteButtonLoading(false);
    }
}

async function setPinnedLocation(kind, coordinates) {
    if (kind === 'source') {
        clearUserRoute();
        setEndpoint('source', coordinates, 'Pinned starting point').openPopup();
        setInputValue('source', 'Pinned start (' + coordinates[0].toFixed(5) + ', ' + coordinates[1].toFixed(5) + ')');
        setInputValue('destination', '');
        setMapStatus('Start set. Click the map again to choose a destination.');
        saveUserRoute();
    } else {
        setEndpoint('destination', coordinates, 'Pinned destination');
        setInputValue('destination', 'Pinned destination (' + coordinates[0].toFixed(5) + ', ' + coordinates[1].toFixed(5) + ')');
        await drawRoute();
    }

    try {
        const label = await reverseGeocode(coordinates);
        setInputValue(kind, label);
        const marker = kind === 'source' ? sourceMarker : destinationMarker;
        if (marker) marker.setPopupContent(
            '<strong>' + (kind === 'source' ? 'Starting point' : 'Destination') + '</strong><br>' + escapeHTML(label)
        );
    } catch (error) {
        console.warn('Could not name pinned location.', error);
    }
    saveUserRoute();
}

map.on('click', function (event) {
    const coordinates = [event.latlng.lat, event.latlng.lng];
    const nextPoint = !sourceCoordinates || destinationCoordinates ? 'source' : 'destination';
    setPinnedLocation(nextPoint, coordinates);
});

function focusIncident(type) {
    const incident = incidents[type];
    if (!incident) return;

    map.flyTo(incident.coordinates, 16, { duration: 0.8 });
    incidentMarkers[type].openPopup();
    setMapStatus('Showing ' + incident.name + '.');
    document.getElementById('map-section').scrollIntoView({ behavior: 'smooth' });
}

function openReportModal() {
    document.getElementById('reportModal').classList.add('active');
}

function closeReportModal() {
    document.getElementById('reportModal').classList.remove('active');
}

function openSOSModal() {
    const modal = document.getElementById('sosModal');
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('call-emergency').focus();
}

function closeSOSModal() {
    const modal = document.getElementById('sosModal');
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.getElementById('open-sos').focus();
}

async function submitReport(event) {
    event.preventDefault();

    const type = document.getElementById('incidentType').value;
    const location = document.getElementById('incidentLocation').value.trim();
    const description = document.getElementById('incidentDescription').value.trim();
    if (!type || !location || !description) return;

    setReportButtonLoading(true);
    setMapStatus('Adding your incident report…');

    try {
        const place = await geocodeLocation(location);
        if (!place) throw new Error('Location not found. Please use a more specific location.');

        const coordinates = [parseFloat(place.lat), parseFloat(place.lon)];
        const response = await fetchApi(`${API_BASE_URL}/reports`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, location, description, coordinates })
        });

        const data = await response.json().catch(function () { return {}; });
        if (!response.ok || !data.success || !data.report) {
            throw new Error(data.error || 'Could not save the incident report.');
        }

        const report = data.report;
        reportedIncidents.unshift(report);

        const marker = addReportedIncidentMarker(report);
        appendReportedIncidentCard(report);
        map.flyTo(report.coordinates, 15, { duration: 0.8 });
        marker.openPopup();
        setMapStatus('Incident reported and added to the map.');
        event.target.reset();
        closeReportModal();
        document.getElementById('map-section').scrollIntoView({ behavior: 'smooth' });
    } catch (error) {
        console.error(error);
        setMapStatus(error.message || 'Could not add this incident report. Please try again.');
    } finally {
        setReportButtonLoading(false);
    }
}

function showAllIncidents() {
    document.getElementById('incidents').scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('open-report').addEventListener('click', openReportModal);
document.getElementById('close-report').addEventListener('click', closeReportModal);
document.getElementById('open-sos').addEventListener('click', openSOSModal);
document.getElementById('close-sos').addEventListener('click', closeSOSModal);
document.getElementById('cancel-sos').addEventListener('click', closeSOSModal);
document.getElementById('find-route').addEventListener('click', findRoute);
document.getElementById('load-more-routes').addEventListener('click', loadMoreRoutes);
document.getElementById('show-incidents').addEventListener('click', showAllIncidents);
document.getElementById('report-form').addEventListener('submit', submitReport);
document.querySelectorAll('[data-incident]').forEach(function (button) {
    button.addEventListener('click', function () {
        focusIncident(button.dataset.incident);
    });
});

document.getElementById('reportModal').addEventListener('click', function (event) {
    if (event.target === this) closeReportModal();
});

document.getElementById('sosModal').addEventListener('click', function (event) {
    if (event.target === this) closeSOSModal();
});

document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && document.getElementById('sosModal').classList.contains('active')) {
        closeSOSModal();
    }
});

addIncidentMarkers();
if (!restoreSavedRoute()) {
    setMapStatus('Click the map to pin a route, search for two places, or report an incident.');
}
loadReportedIncidents();

window.addEventListener('load', function () {
    map.invalidateSize();
    if (restoredSavedRoute) {
        document.getElementById('map-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (routeAlternatives.length) {
            fitRouteBounds(routeCoordinates(routeAlternatives[selectedRouteIndex]));
        }
    }
});
