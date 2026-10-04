import { ImageOff } from 'lucide-react';
import { useState } from 'react';
import './Picture.css';

/** 一张图片：取不到时换成图标加「图片取不到」，读屏名字是替代文字，不留破图。地址换了重新取 */
export function Picture({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState<string>();
  if (failed === src) {
    return (
      <span className="picture-missing" role="img" aria-label={`${alt}（取不到）`}>
        <ImageOff aria-hidden />
        图片取不到
      </span>
    );
  }
  return <img className={className} src={src} alt={alt} loading="lazy" onError={() => setFailed(src)} />;
}
