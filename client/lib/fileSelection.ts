import { v4 as uuidv4 } from 'uuid';

export interface FileWithId {
    id: string;
    file: File;
}

export function mergeFiles(
    previous: FileWithId[],
    incoming: File[]
): FileWithId[] {
    const key = (file: File) =>
        `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

    const seen = new Set(previous.map(({ file }) => key(file)));
    const merged = [...previous];

    for (const file of incoming) {
        const fileKey = key(file);

        if (seen.has(fileKey)) continue;

        seen.add(fileKey);
        merged.push({ id: uuidv4(), file });
    }

    return merged;
}