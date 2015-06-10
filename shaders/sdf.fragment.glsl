uniform sampler2D u_texture;
uniform float u_buffer;
uniform float u_gamma;

varying vec2 v_tex;
varying float v_alpha;
varying float v_gamma_scale;
varying vec4 v_color;

void main() {
    float gamma = u_gamma * v_gamma_scale;
    float dist = texture2D(u_texture, v_tex).a;
    float alpha = smoothstep(u_buffer - gamma, u_buffer + gamma, dist) * v_alpha;
    gl_FragColor = v_color * alpha;
}
