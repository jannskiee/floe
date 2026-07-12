import {FileArchive, FileAudio, FileCode, FileImage, FileText, FileVideo} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';

// Extension → icon, mirroring the website's FileIcon component.
const byExt: Record<string, LucideIcon> = {
    jpg: FileImage, jpeg: FileImage, png: FileImage, gif: FileImage, webp: FileImage, svg: FileImage, bmp: FileImage,
    mp4: FileVideo, webm: FileVideo, mov: FileVideo, avi: FileVideo, mkv: FileVideo, flv: FileVideo,
    mp3: FileAudio, wav: FileAudio, ogg: FileAudio, m4a: FileAudio, flac: FileAudio,
    zip: FileArchive, rar: FileArchive, '7z': FileArchive, tar: FileArchive, gz: FileArchive,
    js: FileCode, ts: FileCode, tsx: FileCode, jsx: FileCode, py: FileCode, go: FileCode,
    html: FileCode, css: FileCode, json: FileCode, c: FileCode, cpp: FileCode,
};

/** FileIcon picks a lucide icon from a file path's extension. */
export default function FileIcon({name}: {name: string}) {
    const base = name.split(/[\\/]/).pop() ?? '';
    const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
    const Icon = byExt[ext] ?? FileText;
    return <Icon className="h-4 w-4 text-zinc-300"/>;
}
