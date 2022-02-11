// @flow
import {
    lngFromMercatorX,
    latFromMercatorY,
    mercatorZfromAltitude,
    mercatorXfromLng,
    mercatorYfromLat
} from '../mercator_coordinate.js';
import EXTENT from '../../data/extent.js';
import {degToRad, smoothstep} from '../../util/util.js';
import {mat4, vec3} from 'gl-matrix';
import SegmentVector from '../../data/segment.js';
import {members as globeLayoutAttributes, atmosphereLayout} from '../../terrain/globe_attributes.js';
import {TriangleIndexArray, GlobeVertexArray, LineIndexArray} from '../../data/array_types.js';
import {Aabb} from '../../util/primitives.js';

import type {CanonicalTileID, OverscaledTileID, UnwrappedTileID} from '../../source/tile_id.js';
import type Context from '../../gl/context.js';
import type {Mat4} from 'gl-matrix';
import type IndexBuffer from '../../gl/index_buffer.js';
import type VertexBuffer from '../../gl/vertex_buffer.js';
import type Tile from '../../source/tile.js';
import type Painter from '../../render/painter.js';
import type Transform from '../transform.js';

export const GLOBE_RADIUS = EXTENT / Math.PI / 2.0;
const GLOBE_NORMALIZATION_BIT_RANGE = 15;
const GLOBE_NORMALIZATION_MASK = (1 << (GLOBE_NORMALIZATION_BIT_RANGE - 1)) - 1;
const GLOBE_VERTEX_GRID_SIZE = 64;
const TILE_SIZE = 512;

const GLOBE_MIN = -GLOBE_RADIUS;
const GLOBE_MAX = GLOBE_RADIUS;

const GLOBE_LOW_ZOOM_TILE_AABBS = [
    // z == 0
    new Aabb([GLOBE_MIN, GLOBE_MIN, GLOBE_MIN], [GLOBE_MAX, GLOBE_MAX, GLOBE_MAX]),
    // z == 1
    new Aabb([GLOBE_MIN, GLOBE_MIN, GLOBE_MIN], [0, 0, GLOBE_MAX]), // x=0, y=0
    new Aabb([0, GLOBE_MIN, GLOBE_MIN], [GLOBE_MAX, 0, GLOBE_MAX]), // x=1, y=0
    new Aabb([GLOBE_MIN, 0, GLOBE_MIN], [0, GLOBE_MAX, GLOBE_MAX]), // x=0, y=1
    new Aabb([0, 0, GLOBE_MIN], [GLOBE_MAX, GLOBE_MAX, GLOBE_MAX])  // x=1, y=1
];

export function globeTileBounds(id: CanonicalTileID): Aabb {
    if (id.z <= 1) {
        return GLOBE_LOW_ZOOM_TILE_AABBS[id.z + id.y * 2 + id.x];
    }

    // After zoom 1 surface function is monotonic for all tile patches
    // => it is enough to project corner points
    const [min, max] = globeTileLatLngCorners(id);

    const corners = [
        latLngToECEF(min[0], min[1]),
        latLngToECEF(min[0], max[1]),
        latLngToECEF(max[0], min[1]),
        latLngToECEF(max[0], max[1])
    ];

    const bMin = [GLOBE_MAX, GLOBE_MAX, GLOBE_MAX];
    const bMax = [GLOBE_MIN, GLOBE_MIN, GLOBE_MIN];

    for (const p of corners) {
        bMin[0] = Math.min(bMin[0], p[0]);
        bMin[1] = Math.min(bMin[1], p[1]);
        bMin[2] = Math.min(bMin[2], p[2]);

        bMax[0] = Math.max(bMax[0], p[0]);
        bMax[1] = Math.max(bMax[1], p[1]);
        bMax[2] = Math.max(bMax[2], p[2]);
    }

    return new Aabb(bMin, bMax);
}

function globeTileLatLngCorners(id: CanonicalTileID) {
    const tileScale = Math.pow(2, id.z);
    const left = id.x / tileScale;
    const right = (id.x + 1) / tileScale;
    const top = id.y / tileScale;
    const bottom = (id.y + 1) / tileScale;

    const latLngTL = [ latFromMercatorY(top), lngFromMercatorX(left) ];
    const latLngBR = [ latFromMercatorY(bottom), lngFromMercatorX(right) ];

    return [latLngTL, latLngBR];
}

function csLatLngToECEF(cosLat: number, sinLat: number, lng: number, radius: ?number): Array<number> {
    lng = degToRad(lng);

    if (!radius) {
        radius = GLOBE_RADIUS;
    }

    // Convert lat & lng to spherical representation. Use zoom=0 as a reference
    const sx = cosLat * Math.sin(lng) * radius;
    const sy = -sinLat * radius;
    const sz = cosLat * Math.cos(lng) * radius;

    return [sx, sy, sz];
}

export function latLngToECEF(lat: number, lng: number, radius: ?number): Array<number> {
    return csLatLngToECEF(Math.cos(degToRad(lat)), Math.sin(degToRad(lat)), lng, radius);
}

export function globeECEFOrigin(tileMatrix: Mat4, id: UnwrappedTileID): [number, number, number] {
    const origin = [0, 0, 0];
    const bounds = globeTileBounds(id.canonical);
    const normalizationMatrix = globeNormalizeECEF(bounds);
    vec3.transformMat4(origin, origin, normalizationMatrix);
    vec3.transformMat4(origin, origin, tileMatrix);
    return origin;
}

export function globeECEFNormalizationScale(bounds: Aabb): number {
    const maxExt = Math.max(...vec3.sub([], bounds.max, bounds.min));
    return GLOBE_NORMALIZATION_MASK / maxExt;
}

export function globeNormalizeECEF(bounds: Aabb): Float64Array {
    const m = mat4.identity(new Float64Array(16));
    const scale = globeECEFNormalizationScale(bounds);
    mat4.scale(m, m, [scale, scale, scale]);
    mat4.translate(m, m, vec3.negate([], bounds.min));
    return m;
}

export function globeDenormalizeECEF(bounds: Aabb): Float64Array {
    const m = mat4.identity(new Float64Array(16));
    const scale = 1.0 / globeECEFNormalizationScale(bounds);
    mat4.translate(m, m, bounds.min);
    mat4.scale(m, m, [scale, scale, scale]);
    return m;
}

export function globeECEFUnitsToPixelScale(worldSize: number): number {
    const localRadius = EXTENT / (2.0 * Math.PI);
    const wsRadius = worldSize / (2.0 * Math.PI);
    return wsRadius / localRadius;
}

export function globePixelsToTileUnits(zoom: number, id: CanonicalTileID): number {
    const ecefPerPixel = EXTENT / (TILE_SIZE * Math.pow(2, zoom));
    const normCoeff = globeECEFNormalizationScale(globeTileBounds(id));

    return ecefPerPixel * normCoeff;
}

function calculateGlobePosMatrix(x, y, worldSize, lng, lat): Float64Array {
    // transform the globe from reference coordinate space to world space
    const scale = globeECEFUnitsToPixelScale(worldSize);
    const offset = [x, y, -worldSize / (2.0 * Math.PI)];
    const m = mat4.identity(new Float64Array(16));
    mat4.translate(m, m, offset);
    mat4.scale(m, m, [scale, scale, scale]);
    mat4.rotateX(m, m, degToRad(-lat));
    mat4.rotateY(m, m, degToRad(-lng));
    return m;
}

export function calculateGlobeMatrix(tr: Transform): Float64Array {
    const {x, y} = tr.point;
    const {lng, lat} = tr._center;
    return calculateGlobePosMatrix(x, y, tr.worldSize, lng, lat);
}

export function calculateGlobeLabelMatrix(tr: Transform, id: CanonicalTileID): Float64Array {
    const {lng, lat} = tr._center;
    // Camera is moved closer towards the ground near poles as part of
    // compesanting the reprojection. This has to be compensated for the
    // map aligned label space. Whithout this logic map aligned symbols
    // would appear larger than intended.
    const m = calculateGlobePosMatrix(0, 0, tr.worldSize / tr._projectionScaler, lng, lat);
    return mat4.multiply(m, m, globeDenormalizeECEF(globeTileBounds(id)));
}

export function calculateGlobeMercatorMatrix(tr: Transform): Float32Array {
    const worldSize = tr.worldSize;
    const point = tr.point;

    const mercatorZ = mercatorZfromAltitude(1, tr.center.lat) * worldSize;
    const projectionScaler = mercatorZ / tr.pixelsPerMeter;
    const zScale = tr.pixelsPerMeter;
    const ws = worldSize / projectionScaler;

    const posMatrix = mat4.identity(new Float64Array(16));
    mat4.translate(posMatrix, posMatrix, [point.x, point.y, 0.0]);
    mat4.scale(posMatrix, posMatrix, [ws, ws, zScale]);

    return Float32Array.from(posMatrix);
}

export const GLOBE_ZOOM_THRESHOLD_MIN = 5;
export const GLOBE_ZOOM_THRESHOLD_MAX = 6;

export function globeToMercatorTransition(zoom: number): number {
    return smoothstep(GLOBE_ZOOM_THRESHOLD_MIN, GLOBE_ZOOM_THRESHOLD_MAX, zoom);
}

export function globeVertexBufferForTileMesh(painter: Painter, tile: Tile, coord: OverscaledTileID): VertexBuffer {
    const context = painter.context;
    const id = coord.canonical;
    let gridBuffer = tile.globeGridBuffer;

    if (!gridBuffer) {
        const gridMesh = GlobeSharedBuffers.createGridVertices(id);
        gridBuffer = tile.globeGridBuffer = context.createVertexBuffer(gridMesh, globeLayoutAttributes, false);
    }

    return gridBuffer;
}

export function globeMatrixForTile(id: CanonicalTileID, globeMatrix: Float64Array): Float32Array {
    const decode = globeDenormalizeECEF(globeTileBounds(id));
    return mat4.mul(mat4.create(), globeMatrix, decode);
}

export function globePoleMatrixForTile(id: CanonicalTileID, isTopCap: boolean, tr: Transform): Float32Array {
    const poleMatrix = mat4.identity(new Float64Array(16));

    const tileDim = Math.pow(2, id.z);
    const xOffset = id.x - tileDim / 2;
    const yRotation = xOffset / tileDim * Math.PI * 2.0;

    const point = tr.point;
    const ws = tr.worldSize;
    const s = tr.worldSize / (tr.tileSize * tileDim);

    mat4.translate(poleMatrix, poleMatrix, [point.x, point.y, -(ws / Math.PI / 2.0)]);
    mat4.scale(poleMatrix, poleMatrix, [s, s, s]);
    mat4.rotateX(poleMatrix, poleMatrix, degToRad(-tr._center.lat));
    mat4.rotateY(poleMatrix, poleMatrix, degToRad(-tr._center.lng));
    mat4.rotateY(poleMatrix, poleMatrix, yRotation);
    if (!isTopCap) {
        mat4.scale(poleMatrix, poleMatrix, [1, -1, 1]);
    }

    return Float32Array.from(poleMatrix);
}

export class GlobeSharedBuffers {
    poleNorthVertexBuffer: VertexBuffer;
    poleSouthVertexBuffer: VertexBuffer;
    poleIndexBuffer: IndexBuffer;
    poleSegments: SegmentVector;

    gridIndexBuffer: IndexBuffer;
    gridSegments: SegmentVector;

    atmosphereVertexBuffer: VertexBuffer;
    atmosphereIndexBuffer: IndexBuffer;
    atmosphereSegments: SegmentVector;

    wireframeIndexBuffer: IndexBuffer;
    wireframeSegments: SegmentVector;

    constructor(context: Context) {
        const gridIndices = this._createGridIndices();
        this.gridIndexBuffer = context.createIndexBuffer(gridIndices, true);

        const gridPrimitives = GLOBE_VERTEX_GRID_SIZE * GLOBE_VERTEX_GRID_SIZE * 2;
        const gridVertices = (GLOBE_VERTEX_GRID_SIZE + 1) * (GLOBE_VERTEX_GRID_SIZE + 1);
        this.gridSegments = SegmentVector.simpleSegment(0, 0, gridVertices, gridPrimitives);

        const poleIndices = this._createPoleTriangleIndices();
        this.poleIndexBuffer = context.createIndexBuffer(poleIndices, true);

        const poleNorthVertices = this._createPoleVerticesForAllZooms(true);
        const poleSouthVertices = this._createPoleVerticesForAllZooms(false);

        this.poleNorthVertexBuffer = context.createVertexBuffer(poleNorthVertices, globeLayoutAttributes, false);
        this.poleSouthVertexBuffer = context.createVertexBuffer(poleSouthVertices, globeLayoutAttributes, false);
        this.poleSegments = this._createPoleSegments();

        const atmosphereVertices = new GlobeVertexArray();
        atmosphereVertices.emplaceBack(-1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0);
        atmosphereVertices.emplaceBack(1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0);
        atmosphereVertices.emplaceBack(1.0, -1.0, 1.0, 0.0, 0.0, 1.0, 1.0);
        atmosphereVertices.emplaceBack(-1.0, -1.0, 1.0, 0.0, 0.0, 0.0, 1.0);

        const atmosphereTriangles = new TriangleIndexArray();
        atmosphereTriangles.emplaceBack(0, 1, 2);
        atmosphereTriangles.emplaceBack(2, 3, 0);

        this.atmosphereVertexBuffer = context.createVertexBuffer(atmosphereVertices, atmosphereLayout.members);
        this.atmosphereIndexBuffer = context.createIndexBuffer(atmosphereTriangles);
        this.atmosphereSegments = SegmentVector.simpleSegment(0, 0, 4, 2);
    }

    destroy() {
        this.poleIndexBuffer.destroy();
        this.gridIndexBuffer.destroy();
        this.poleNorthVertexBuffer.destroy();
        this.poleSouthVertexBuffer.destroy();
        this.poleSegments.destroy();
        this.gridSegments.destroy();
        this.atmosphereVertexBuffer.destroy();
        this.atmosphereIndexBuffer.destroy();
        this.atmosphereSegments.destroy();

        if (this.wireframeIndexBuffer) {
            this.wireframeIndexBuffer.destroy();
            this.wireframeSegments.destroy();
        }
    }

    _createPoleVertices(zoom: number, isTopCap: boolean, outArr: GlobeVertexArray) {
        const lerp = (a, b, t) => a * (1 - t) + b * t;
        const tiles = 1 << zoom;
        const worldSize = tiles * TILE_SIZE;
        const radius = worldSize / Math.PI / 2.0;

        // Place the tip
        outArr.emplaceBack(0, -radius, 0, 0, 0, 0.5, isTopCap ? 0.0 : 1.0);

        const startAngle = 0;
        const endAngle = 360.0 / tiles;
        const cosLat = Math.cos(degToRad(85.0));
        const sinLat = Math.sin(degToRad(85.0));

        for (let i = 0; i <= GLOBE_VERTEX_GRID_SIZE; i++) {
            const uvX = i / GLOBE_VERTEX_GRID_SIZE;
            const angle = lerp(startAngle, endAngle, uvX);
            const p = csLatLngToECEF(cosLat, sinLat, angle, radius);

            outArr.emplaceBack(p[0], p[1], p[2], 0, 0, uvX, isTopCap ? 0.0 : 1.0);
        }
    }

    _createPoleVerticesForAllZooms(isTopCap: boolean): GlobeVertexArray {
        const vertices = new GlobeVertexArray();

        for (let zoom = 0; zoom < GLOBE_ZOOM_THRESHOLD_MIN; zoom++) {
            this._createPoleVertices(zoom, isTopCap, vertices);
        }

        return vertices;
    }

    _createPoleTriangleIndices(): TriangleIndexArray {
        const arr = new TriangleIndexArray();
        for (let i = 0; i <= GLOBE_VERTEX_GRID_SIZE; i++) {
            arr.emplaceBack(0, i + 1, i + 2);
        }
        return arr;
    }

    _createPoleSegments(): SegmentVector {
        const segments = [];
        let offset = 0;

        const polePrimitives = GLOBE_VERTEX_GRID_SIZE;
        const poleVertices = GLOBE_VERTEX_GRID_SIZE + 2;

        for (let zoom = 0; zoom < GLOBE_ZOOM_THRESHOLD_MIN; zoom++) {
            segments.push({
                vertexOffset: offset,
                primitiveOffset: 0,
                vertexLength: poleVertices,
                primitiveLength: polePrimitives,
                vaos: {},
                sortKey: 0
            });

            offset += poleVertices;
        }

        return new SegmentVector(segments);
    }

    static createGridVertices(id: CanonicalTileID): GlobeVertexArray {
        const tiles = Math.pow(2, id.z);
        const lerp = (a, b, t) => a * (1 - t) + b * t;
        const [latLngTL, latLngBR] = globeTileLatLngCorners(id);
        const boundsArray = new GlobeVertexArray();

        const norm = globeNormalizeECEF(globeTileBounds(id));

        const vertexExt = GLOBE_VERTEX_GRID_SIZE + 1;
        boundsArray.reserve(GLOBE_VERTEX_GRID_SIZE * GLOBE_VERTEX_GRID_SIZE);

        for (let y = 0; y < vertexExt; y++) {
            const lat = lerp(latLngTL[0], latLngBR[0], y / GLOBE_VERTEX_GRID_SIZE);
            const mercatorY = mercatorYfromLat(lat);
            const uvY = (mercatorY * tiles) - id.y;
            const sinLat = Math.sin(degToRad(lat));
            const cosLat = Math.cos(degToRad(lat));
            for (let x = 0; x < vertexExt; x++) {
                const uvX = x / GLOBE_VERTEX_GRID_SIZE;
                const lng = lerp(latLngTL[1], latLngBR[1], uvX);

                const pGlobe = csLatLngToECEF(cosLat, sinLat, lng);
                vec3.transformMat4(pGlobe, pGlobe, norm);

                const mercatorX = mercatorXfromLng(lng);

                boundsArray.emplaceBack(pGlobe[0], pGlobe[1], pGlobe[2], mercatorX, mercatorY, uvX, uvY);
            }
        }

        return boundsArray;
    }

    _createGridIndices(): TriangleIndexArray {
        const indexArray = new TriangleIndexArray();
        const quadExt = GLOBE_VERTEX_GRID_SIZE;
        const vertexExt = quadExt + 1;
        const quad = (i, j) => {
            const index = j * vertexExt + i;
            indexArray.emplaceBack(index + 1, index, index + vertexExt);
            indexArray.emplaceBack(index + vertexExt, index + vertexExt + 1, index + 1);
        };
        for (let j = 0; j < quadExt; j++) {
            for (let i = 0; i < quadExt; i++) {
                quad(i, j);
            }
        }
        return indexArray;
    }

    getWirefameBuffer(context: Context): [IndexBuffer, SegmentVector] {
        if (!this.wireframeSegments) {
            const wireframeGridIndices = this._createWireframeGrid();
            this.wireframeIndexBuffer = context.createIndexBuffer(wireframeGridIndices);

            const vertexBufferLength = GLOBE_VERTEX_GRID_SIZE * GLOBE_VERTEX_GRID_SIZE;
            this.wireframeSegments = SegmentVector.simpleSegment(0, 0, vertexBufferLength, wireframeGridIndices.length);
        }
        return [this.wireframeIndexBuffer, this.wireframeSegments];
    }

    _createWireframeGrid(): LineIndexArray {
        const indexArray = new LineIndexArray();

        const quadExt = GLOBE_VERTEX_GRID_SIZE;
        const vertexExt = quadExt + 1;

        const quad = (i, j) => {
            const index = j * vertexExt + i;
            indexArray.emplaceBack(index, index + 1);
            indexArray.emplaceBack(index, index + vertexExt);
            indexArray.emplaceBack(index, index + vertexExt + 1);
        };

        for (let j = 0; j < quadExt; j++) {
            for (let i = 0; i < quadExt; i++) {
                quad(i, j);
            }
        }

        return indexArray;
    }

    getPoleBuffersForTile(zoom: number, isTopCap: boolean): [VertexBuffer, ?SegmentVector] {
        return [
            isTopCap ? this.poleNorthVertexBuffer : this.poleSouthVertexBuffer,
            zoom >= 0 && zoom < this.poleSegments.get().length ? new SegmentVector([this.poleSegments.get()[zoom]]) : null
        ];
    }
}
