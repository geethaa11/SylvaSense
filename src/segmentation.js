export function runPrototypeSegmentation(latlngs, _areaHa) {
    if (!latlngs || latlngs.length === 0) return { featureCollection: null, demoObjects: [], objectCount: 0, validPixels: 0, canopyPixels: 0, canopyCoverPercent: 0 };
    
    // Calculate bounding box
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    latlngs.forEach(pt => {
        if (pt.lat < minLat) minLat = pt.lat;
        if (pt.lat > maxLat) maxLat = pt.lat;
        if (pt.lng < minLng) minLng = pt.lng;
        if (pt.lng > maxLng) maxLng = pt.lng;
    });

    function isPointInPolygon(lat, lng) {
        let inside = false;
        for (let i = 0, j = latlngs.length - 1; i < latlngs.length; j = i++) {
            const xi = latlngs[i].lat, yi = latlngs[i].lng;
            const xj = latlngs[j].lat, yj = latlngs[j].lng;
            const intersect = ((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    // Simulate Raster resolution dynamically based on polygon size to prevent skipping small polygons
    let stepLat = (maxLat - minLat) / 40;
    let stepLng = (maxLng - minLng) / 40;
    // ensure a reasonable minimum and maximum
    if (stepLat === 0) stepLat = 0.00005;
    if (stepLng === 0) stepLng = 0.00005;
    // avoid freezing on massive polygons
    if (stepLat > 0.002) stepLat = 0.002;
    if (stepLng > 0.002) stepLng = 0.002;
    
    let validPixels = 0;
    let canopyPixels = 0;
    const features = [];
    const demoObjects = [];
    
    // Simulate feature extraction: scan grid
    for (let lat = minLat; lat <= maxLat; lat += stepLat) {
        for (let lng = minLng; lng <= maxLng; lng += stepLng) {
            if (isPointInPolygon(lat, lng)) {
                validPixels++;
                // Simulate NDVI thresholding
                if (Math.random() > 0.3) {
                    canopyPixels++;
                    
                    if (features.length < 500 && Math.random() > 0.5) {
                        const radius = stepLat * (0.3 + Math.random() * 0.4);
                        
                        // For map rendering (CircleMarkers are visible at any zoom)
                        demoObjects.push({
                            lat: lat,
                            lng: lng,
                            radius: Math.random() * 2 + 1
                        });

                        // For GeoJSON export (Actual polygons)
                        const hex = [];
                        for(let i=0; i<6; i++) {
                            const angle = (Math.PI / 3) * i;
                            hex.push([lng + radius * Math.cos(angle), lat + radius * Math.sin(angle)]);
                        }
                        hex.push(hex[0]); // close polygon
                        
                        features.push({
                            type: "Feature",
                            properties: {
                                class: "canopy_object",
                                source: "prototype_segmentation",
                                simulated_area_m2: Math.round(Math.random() * 50 + 20)
                            },
                            geometry: {
                                type: "Polygon",
                                coordinates: [hex]
                            }
                        });
                    }
                }
            }
        }
    }

    const canopyCoverPercent = validPixels > 0 ? (canopyPixels / validPixels) * 100 : 0;
    const objectCount = Math.round(canopyPixels * 0.8);
    
    const featureCollection = {
        type: "FeatureCollection",
        features: features
    };

    return { featureCollection, demoObjects, objectCount, validPixels, canopyPixels, canopyCoverPercent };
}
