/**
 * The "WebTrad" bookmark. Websites behind an anti-bot wall (Cloudflare…)
 * refuse the relays WebTrad reads pages through, but they open normally for
 * the reader in their own browser. Tapped on such a chapter page, this
 * bookmark collects the addresses of its images (lazy-loaded ones included),
 * its title and its "next" link, and opens WebTrad's import screen with them.
 * Nothing is bypassed: it only reads the page the reader is looking at.
 *
 * Plain ES2017 on purpose: it runs as is in the website's page.
 */
const SOURCE = `(async()=>{
const A=__APP__,seen=new Set(),imgs=[];
const last=s=>s?s.split(',').pop().trim().split(/\\s+/)[0]:'';
const add=v=>{if(!v)return;v=v.trim();if(!v||v.startsWith('data:'))return;try{v=new URL(v,location.href).href}catch(e){return}if(/^https?:/.test(v)&&!seen.has(v)){seen.add(v);imgs.push(v)}};
for(const i of document.querySelectorAll('img')){const d=i.dataset,lazy=d.src||d.lazySrc||d.original||d.url||last(d.srcset);if(!lazy&&i.complete&&i.naturalWidth&&(i.naturalWidth<200||i.naturalHeight<200))continue;add(lazy||i.currentSrc||last(i.getAttribute('srcset'))||i.src)}
if(!imgs.length){alert('WebTrad : aucune image trouvée sur cette page.');return}
const nx=document.querySelector('link[rel~=next][href],a[rel~=next][href]')||[...document.querySelectorAll('a[href]')].find(a=>/(^|[\\s_-])next/i.test(a.className+' '+a.id)||/^\\s*(next|suivant|chapitre suivant|next chapter|다음|次|下一)/i.test(a.textContent||''));
const next=nx&&/^https?:/.test(nx.href)?nx.href:'';
try{await Promise.race([navigator.clipboard.writeText(imgs.join('\\n')),new Promise(r=>setTimeout(r,800))])}catch(e){}
const cv=document.querySelector('meta[property="og:image"],meta[name="twitter:image"]');
location.href=A+'#/new?'+new URLSearchParams({images:imgs.join('\\n'),title:document.title,page:location.href,next:next,cover:cv&&cv.content||''});
})();`;

/** `javascript:` address of the bookmark for the WebTrad installed at `appUrl`. */
export function bookmarkletCode(appUrl: string): string {
  const code = SOURCE.replace('__APP__', JSON.stringify(appUrl)).replace(/\n/g, '');
  return 'javascript:' + encodeURIComponent(code);
}

/** Address of this WebTrad, without the route. */
export function currentAppUrl(): string {
  return location.origin + location.pathname;
}
