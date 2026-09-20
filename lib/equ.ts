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
