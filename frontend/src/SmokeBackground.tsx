import { useEffect, useRef } from "react";

const fragmentShaderSource = `#version 300 es
precision highp float;
out vec4 O;
uniform float time;
uniform vec2 resolution;
uniform vec3 u_color;

#define FC gl_FragCoord.xy
#define R resolution
#define T (time+660.)

float rnd(vec2 p){p=fract(p*vec2(12.9898,78.233));p+=dot(p,p+34.56);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);return mix(mix(rnd(i),rnd(i+vec2(1,0)),u.x),mix(rnd(i+vec2(0,1)),rnd(i+1.),u.x),u.y);}
float fbm(vec2 p){float t=.0,a=1.;for(int i=0;i<5;i++){t+=a*noise(p);p*=mat2(1,-1.2,.2,1.2)*2.;a*=.5;}return t;}

void main(){
  vec2 uv=(FC-.5*R)/R.y;
  vec3 col=vec3(1);
  uv.x+=.25;
  uv*=vec2(2,1);

  float n=fbm(uv*.28-vec2(T*.01,0));
  n=noise(uv*3.+n*2.);

  col.r-=fbm(uv+vec2(0,T*.015)+n);
  col.g-=fbm(uv*1.003+vec2(0,T*.015)+n+.003);
  col.b-=fbm(uv*1.006+vec2(0,T*.015)+n+.006);

  col=mix(col, u_color, dot(col,vec3(.21,.71,.07)));
  col=mix(vec3(.08),col,min(time*.1,1.));
  col=clamp(col,.08,1.);
  O=vec4(col,1);
}`;

type Uniforms = {
  resolution: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
};

class Renderer {
  private readonly vertexSrc = `#version 300 es
precision highp float;
in vec4 position;
void main(){gl_Position=position;}`;
  private readonly vertices = [-1, 1, -1, -1, 1, 1, 1, -1];

  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private program: WebGLProgram | null = null;
  private vs: WebGLShader | null = null;
  private fs: WebGLShader | null = null;
  private buffer: WebGLBuffer | null = null;
  private uniforms: Uniforms = { resolution: null, time: null, color: null };
  private color: [number, number, number] = [0.24, 1, 0.52];

  constructor(canvas: HTMLCanvasElement, fragmentSource: string) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: true });
    if (!gl) {
      throw new Error("WebGL2 is not available.");
    }
    this.canvas = canvas;
    this.gl = gl;
    this.setup(fragmentSource);
    this.init();
  }

  updateColor(newColor: [number, number, number]) {
    this.color = newColor;
  }

  updateScale() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  reset() {
    const { gl, program, vs, fs, buffer } = this;
    if (program) {
      if (vs) gl.detachShader(program, vs);
      if (fs) gl.detachShader(program, fs);
      gl.deleteProgram(program);
    }
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    if (buffer) gl.deleteBuffer(buffer);
    this.program = null;
    this.vs = null;
    this.fs = null;
    this.buffer = null;
  }

  private compile(shader: WebGLShader, source: string) {
    const gl = this.gl;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? "Shader compilation failed.");
    }
  }

  private setup(fragmentSource: string) {
    const gl = this.gl;
    this.vs = gl.createShader(gl.VERTEX_SHADER);
    this.fs = gl.createShader(gl.FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!this.vs || !this.fs || !program) {
      throw new Error("Unable to create shader program.");
    }
    this.compile(this.vs, this.vertexSrc);
    this.compile(this.fs, fragmentSource);
    this.program = program;
    gl.attachShader(program, this.vs);
    gl.attachShader(program, this.fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "Program linking failed.");
    }
  }

  private init() {
    const { gl, program } = this;
    if (!program) return;
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.vertices), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.uniforms = {
      resolution: gl.getUniformLocation(program, "resolution"),
      time: gl.getUniformLocation(program, "time"),
      color: gl.getUniformLocation(program, "u_color")
    };
  }

  render(now = 0) {
    const { gl, program, buffer, canvas, uniforms } = this;
    if (!program || !buffer || !gl.isProgram(program)) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.time, now * 1e-3);
    gl.uniform3fv(uniforms.color, this.color);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function hexToRgb(hex: string): [number, number, number] | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [
        parseInt(result[1], 16) / 255,
        parseInt(result[2], 16) / 255,
        parseInt(result[3], 16) / 255
      ]
    : null;
}

export function SmokeBackground({ smokeColor = "#3cff82" }: { smokeColor?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    let animationFrameId = 0;
    let renderer: Renderer;
    try {
      renderer = new Renderer(canvasRef.current, fragmentShaderSource);
    } catch (error) {
      console.warn(error);
      return;
    }
    rendererRef.current = renderer;

    const handleResize = () => renderer.updateScale();
    handleResize();
    window.addEventListener("resize", handleResize);

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const loop = (now: number) => {
      renderer.render(now);
      if (!reduceMotion) {
        animationFrameId = requestAnimationFrame(loop);
      }
    };
    loop(0);

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationFrameId);
      renderer.reset();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const rgbColor = hexToRgb(smokeColor);
    if (rgbColor) {
      rendererRef.current?.updateColor(rgbColor);
    }
  }, [smokeColor]);

  return <canvas ref={canvasRef} className="smokeBackgroundCanvas" aria-hidden="true" />;
}
