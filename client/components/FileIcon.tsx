import React from 'react';
import {
    FileImage,
    FileVideo,
    FileAudio,
    FileArchive,
    FileCode,
    FileText,
} from 'lucide-react';

interface FileIconProps {
    fileName: string;
    className?: string;
}

export const FileIcon = ({
    fileName,
    className = 'h-4 w-4 text-zinc-200',
}: FileIconProps) => {
    const ext = fileName.split('.').pop()?.toLowerCase();

    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext || ''))
        return <FileImage className={className} />;

    if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv'].includes(ext || ''))
        return <FileVideo className={className} />;

    if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext || ''))
        return <FileAudio className={className} />;

    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext || ''))
        return <FileArchive className={className} />;

    if (
        [
            'js',
            'ts',
            'tsx',
            'jsx',
            'py',
            'html',
            'css',
            'json',
            'c',
            'cpp',
        ].includes(ext || '')
    )
        return <FileCode className={className} />;

    return <FileText className={className} />;
};
