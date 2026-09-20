export interface FindEquResult {
    path: string;
    file: Record<string, { size: String; count: number; paths: string[] }>;
    total: {
        fileCount: number;
        totalSize: String;
        duplicateCount: number;
        duplicateSize: String;
        md5Count: number;
    };
}

export interface MvEquResult {
    source: string;
    target: string;
    moved: string[];
    skipped: Array<{ path: string; reason: string }>;
    total: {
        movedCount: number;
        skippedCount: number;
    };
}
