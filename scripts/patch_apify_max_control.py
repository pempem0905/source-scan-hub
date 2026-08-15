from pathlib import Path
p=Path('src/routes/api/bootstrap-native-apify.ts')
s=p.read_text()

# Allow Actor versions to receive encrypted environment variables.
s=s.replace(
'async function buildActor(actorId: string, files: z.infer<typeof fileSchema>[]) {\n  const version = { versionNumber: "1.0", buildTag: "latest", sourceType: "SOURCE_FILES", sourceFiles: files };',
'async function buildActor(actorId: string, files: z.infer<typeof fileSchema>[], envVars: Array<{ name: string; value: string; isSecret?: boolean }> = []) {\n  const version = { versionNumber: "1.0", buildTag: "latest", sourceType: "SOURCE_FILES", sourceFiles: files, envVars };'
)

# Max-throughput input while preserving total project cap.
s=s.replace('localConcurrency: 10,\n    maxWorkerItems: 600,\n    maxWorkerRunMinutes: 20,\n    maxCycleMinutes: 50,\n    dailyBudgetUsd: 1,\n    projectBudgetUsd: 50,',
'''localConcurrency: 10,
    maxWorkerItems: 1200,
    maxWorkerRunMinutes: 30,
    maxCycleMinutes: 170,
    dailyBudgetUsd: 10,
    projectBudgetUsd: 50,''')
s=s.replace('cronExpression: "0 */3 * * *",', 'cronExpression: "*/15 * * * *",')
s=s.replace('timeoutSecs: 4200, memoryMbytes: 256, maxTotalChargeUsd: 0.1,', 'timeoutSecs: 10800, memoryMbytes: 256, maxTotalChargeUsd: 0.5,')
s=s.replace('memory: "256", timeout: "4200", build: "latest", maxTotalChargeUsd: "0.1", forcePermissionLevel: "FULL_PERMISSIONS"', 'memory: "256", timeout: "10800", build: "latest", maxTotalChargeUsd: "0.5", forcePermissionLevel: "FULL_PERMISSIONS"')

# Worker receives Brave key only as an encrypted Apify Actor env var.
old='if (workerFiles) builds.worker = await buildActor(worker.id, workerFiles);'
new='if (workerFiles) builds.worker = await buildActor(worker.id, workerFiles, [{ name: "BRAVE_SEARCH_API_KEY", value: secret("BRAVE_SEARCH_API_KEY"), isSecret: true }]);'
if old in s:
    s=s.replace(old,new,1)

p.write_text(s)
