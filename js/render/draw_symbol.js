'use strict';

var browser = require('../util/browser');
var drawCollisionDebug = require('./draw_collision_debug');
var util = require('../util/util');
var pixelsToTileUnits = require('../source/pixels_to_tile_units');


module.exports = drawSymbols;

function drawSymbols(painter, source, layer, coords) {
    if (painter.isOpaquePass) return;

    var drawAcrossEdges = !(layer.layout['text-allow-overlap'] || layer.layout['icon-allow-overlap'] ||
        layer.layout['text-ignore-placement'] || layer.layout['icon-ignore-placement']);

    var gl = painter.gl;

    // Disable the stencil test so that labels aren't clipped to tile boundaries.
    //
    // Layers with features that may be drawn overlapping aren't clipped. These
    // layers are sorted in the y direction, and to draw the correct ordering near
    // tile edges the icons are included in both tiles and clipped when drawing.
    if (drawAcrossEdges) {
        gl.disable(gl.STENCIL_TEST);
    } else {
        gl.enable(gl.STENCIL_TEST);
    }

    painter.setDepthSublayer(0);
    painter.depthMask(false);
    gl.disable(gl.DEPTH_TEST);

    drawLayerSymbols(painter, source, layer, coords, false,
            layer.paint['icon-translate'],
            layer.paint['icon-translate-anchor'],
            layer.layout['icon-rotation-alignment'],
            layer.layout['icon-size'],
            layer.paint['icon-halo-width'],
            layer.paint['icon-halo-color'],
            layer.paint['icon-halo-blur'],
            layer.paint['icon-opacity'],
            layer.paint['icon-color']);

    drawLayerSymbols(painter, source, layer, coords, true,
            layer.paint['text-translate'],
            layer.paint['text-translate-anchor'],
            layer.layout['text-rotation-alignment'],
            layer.layout['text-size'],
            layer.paint['text-halo-width'],
            layer.paint['text-halo-color'],
            layer.paint['text-halo-blur'],
            layer.paint['text-opacity'],
            layer.paint['text-color']);

    gl.enable(gl.DEPTH_TEST);

    drawCollisionDebug(painter, source, layer, coords);
}

function drawLayerSymbols(painter, source, layer, coords, isText,
        translate,
        translateAnchor,
        rotationAlignment,
        size,
        haloWidth,
        haloColor,
        haloBlur,
        opacity,
        color) {

    haloColor = util.premultiply(haloColor);
    color = util.premultiply(color);

    for (var j = 0; j < coords.length; j++) {
        var tile = source.getTile(coords[j]);
        var bucket = tile.getBucket(layer);
        if (!bucket) continue;
        var bothElementGroups = bucket.elementGroups;
        var elementGroups = isText ? bothElementGroups.glyph : bothElementGroups.icon;
        if (!elementGroups.length) continue;

        painter.enableTileClippingMask(coords[j]);
        drawSymbol(painter, layer, coords[j].posMatrix, tile, bucket, elementGroups, isText,
                isText || bothElementGroups.sdfIcons, !isText && bothElementGroups.iconsNeedLinear,
                translate,
                translateAnchor,
                rotationAlignment,
                size,
                haloWidth,
                haloColor,
                haloBlur,
                opacity,
                color);
    }
}

function drawSymbol(painter, layer, posMatrix, tile, bucket, elementGroups, isText, sdf, iconsNeedLinear,
        translate,
        translateAnchor,
        rotationAlignment,
        size,
        haloWidth,
        haloColor,
        haloBlur,
        opacity,
        color) {
    var gl = painter.gl;

    var programInterfaceName = isText ? 'glyph' : 'icon';

    var tr = painter.transform;
    var alignedWithMap = rotationAlignment === 'map';

    var fontSize = size;
    var defaultSize = isText ? 24 : 1;
    var fontScale = fontSize / defaultSize;

    var skewed = alignedWithMap;
    var extrudeScale, s, gammaScale;

    if (skewed) {
        s = pixelsToTileUnits(tile, 1, painter.transform.zoom) * fontScale;
        gammaScale = 1 / Math.cos(tr._pitch);
        extrudeScale = [s, s];
    } else {
        s = painter.transform.altitude * fontScale;
        gammaScale = 1;
        extrudeScale = [ tr.pixelsToGLUnits[0] * s, tr.pixelsToGLUnits[1] * s];
    }

    // calculate how much longer the real world distance is at the top of the screen
    // than at the middle of the screen.
    var topedgelength = Math.sqrt(tr.height * tr.height / 4  * (1 + tr.altitude * tr.altitude));
    var x = tr.height / 2 * Math.tan(tr._pitch);
    var extra = (topedgelength + x) / topedgelength - 1;

    if (!isText && !painter.style.sprite.loaded())
        return;

    gl.activeTexture(gl.TEXTURE0);

    var program = painter.useProgram(sdf ? 'sdf' : 'icon');
    gl.uniformMatrix4fv(program.u_matrix, false, painter.translatePosMatrix(posMatrix, tile, translate, translateAnchor));

    var texsize;
    if (isText) {
        // use the fonstack used when parsing the tile, not the fontstack
        // at the current zoom level (layout['text-font']).
        var fontstack = elementGroups.fontstack;
        var glyphAtlas = fontstack && painter.glyphSource.getGlyphAtlas(fontstack);
        if (!glyphAtlas) return;

        glyphAtlas.updateTexture(gl);
        texsize = [glyphAtlas.width / 4, glyphAtlas.height / 4];
    } else {
        var mapMoving = painter.options.rotating || painter.options.zooming;
        var iconScaled = fontScale !== 1 || browser.devicePixelRatio !== painter.spriteAtlas.pixelRatio || iconsNeedLinear;
        var iconTransformed = alignedWithMap || painter.transform.pitch;
        painter.spriteAtlas.bind(gl, sdf || mapMoving || iconScaled || iconTransformed);
        texsize = [painter.spriteAtlas.width / 4, painter.spriteAtlas.height / 4];
    }

    gl.uniform1i(program.u_texture, 0);
    gl.uniform2fv(program.u_texsize, texsize);
    gl.uniform1i(program.u_skewed, skewed);
    gl.uniform1f(program.u_extra, extra);
    gl.uniform2fv(program.u_extrude_scale, extrudeScale);

    // adjust min/max zooms for variable font sizes
    var zoomAdjust = Math.log(fontSize / elementGroups.adjustedSize) / Math.LN2 || 0;


    gl.uniform1f(program.u_zoom, (painter.transform.zoom - zoomAdjust) * 10); // current zoom level

    gl.activeTexture(gl.TEXTURE1);
    painter.frameHistory.bind(gl);
    gl.uniform1i(program.u_fadetexture, 1);

    var group, count;

    var buffers = bucket.buffers[programInterfaceName].layout;
    var vertexBuffer = buffers.vertex;
    var elementBuffer = buffers.element;

    if (sdf) {
        var sdfPx = 8;
        var blurOffset = 1.19;
        var haloOffset = 6;
        var gamma = 0.105 * defaultSize / fontSize / browser.devicePixelRatio;

        if (haloWidth) {
            // Draw halo underneath the text.
            gl.uniform1f(program.u_gamma, (haloBlur * blurOffset / fontScale / sdfPx + gamma) * gammaScale);
            gl.uniform4fv(program.u_color, haloColor);
            gl.uniform1f(program.u_opacity, opacity);
            gl.uniform1f(program.u_buffer, (haloOffset - haloWidth / fontScale) / sdfPx);

            for (var j = 0; j < elementGroups.length; j++) {
                group = elementGroups[j];
                count = group.elementLength * 3;
                group.vaos[layer.id].bind(gl, program, vertexBuffer, undefined, group.vertexStartIndex, elementBuffer);
                gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, group.elementOffset);
            }
        }

        gl.uniform1f(program.u_gamma, gamma * gammaScale);
        gl.uniform4fv(program.u_color, color);
        gl.uniform1f(program.u_opacity, opacity);
        gl.uniform1f(program.u_buffer, (256 - 64) / 256);

        for (var i = 0; i < elementGroups.length; i++) {
            group = elementGroups[i];
            count = group.elementLength * 3;
            group.vaos[layer.id].bind(gl, program, vertexBuffer, undefined, group.vertexStartIndex, elementBuffer);
            gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, group.elementOffset);
        }

    } else {
        gl.uniform1f(program.u_opacity, opacity);
        for (var k = 0; k < elementGroups.length; k++) {
            group = elementGroups[k];
            count = group.elementLength * 3;
            group.vaos[layer.id].bind(gl, program, vertexBuffer, undefined, group.vertexStartIndex, elementBuffer);
            gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, group.elementOffset);
        }
    }
}
