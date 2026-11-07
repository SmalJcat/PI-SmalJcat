import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const theme=readFileSync(new URL('../src/cyberpunk.css',import.meta.url),'utf8');
const luminance=hex=>{
 const rgb=hex.match(/\w\w/g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
 return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
};
const contrast=(a,b)=>{const [hi,lo]=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (hi+.05)/(lo+.05);};
test('cyberpunk text tokens meet WCAG AA on base and raised surfaces',()=>{
 const token=name=>{const m=theme.match(new RegExp(`--${name}: #([0-9a-f]{6})`));assert(m,`missing ${name}`);return m[1];};
 for(const text of ['text','muted','accent'])for(const surface of ['bg','sidebar','panel','surface','surface-raised','hover'])
  assert(contrast(token(text),token(surface))>=4.5,`${text} on ${surface}`);
 assert(contrast(token('accent'),'06202a')>=4.5,'primary button label');
});
test('theme keeps accessibility and opaque fallbacks',()=>{
 assert.match(theme,/color-scheme: dark/);
 assert.match(theme,/prefers-reduced-transparency/);
 assert.match(theme,/forced-colors: active/);
 assert.match(theme,/button:focus-visible/);
});
