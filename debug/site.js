
var map = new llmr.Map({
    container: 'map',
    sources: {
        "mapbox streets": {
            type: 'vector',
            url: 'http://{s}.tiles.mapbox.com/v3/mapbox.mapbox-streets-v4/{z}/{x}/{y}.vector.pbf',
            glyphs: 'http://mapbox.s3.amazonaws.com/gl-glyphs-256/{fontstack}/{range}.pbf',
            tileSize: 512,
            maxZoom: 14,
            skipZooms: [1, 9, 11]
        },
        "satellite": {
            type: 'raster',
            url: 'http://api.tiles.mapbox.com/v3/aibram.map-vlob92uz/{z}/{x}/{y}.png',
            maxZoom: 17
        }
    },
    zoom: 15,
    center: [38.912753, -77.032194],
    style: style,
    hash: true
});

new llmr.Navigation(map);

// add geojson overlay
var geojson = new llmr.GeoJSONSource({ type: 'Feature', properties: {}, geometry: route.routes[0].geometry});
map.addSource('geojson', geojson);
