#!/usr/bin/env node

import { resolve, join } from "path";
import * as fs from "fs";
import * as git from "isomorphic-git";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  _Object,
} from "@aws-sdk/client-s3";
import * as cliProgress from "cli-progress";

import * as dayjs from "dayjs";
import { Agent } from "https";
import { execSync } from "child_process";

const client = new S3Client({
  requestHandler: new NodeHttpHandler({
    httpsAgent: new Agent({
      maxSockets: 500,
      keepAlive: true,
      keepAliveMsecs: 1000,
    }),
    socketTimeout: 5000,
  }),
});

const dir = resolve(__dirname, "stack-history");
const fileName = "checkpoint.json";

let currentStack: string | undefined;
let backendBucketName: string | undefined;

const bucketObjectsPageSize = 1000;
let objectCounter = 0;

let prefix: string;

type CheckpointMetadata = {
  startTime: number;
  endTime: number;
  message: string;
  result: "succeeded";
  resourceChanges: object;
  environment: {
    "git.author": string;
    "git.author.email": string;
  };
};


const progressBar = new cliProgress.SingleBar(
  {
    format: '{bar} {percentage}% | ETA: {eta}s | {value}/{total} | {log}'
  },
  cliProgress.Presets.shades_classic
);

const createCommitForCheckpoint = async (
  fileContents: string,
  metadata: CheckpointMetadata
) => {
  progressBar.update({ log: `  Creating commit for revision from ${metadata.startTime}` });

  const message = metadata.message;
  const username = metadata.environment["git.author"];
  const date = metadata.startTime;

  fs.writeFileSync(join(dir, fileName), fileContents);
  await git.add({ fs, dir, filepath: fileName });

  const committer = {
    name: username,
    email: metadata.environment["git.author.email"],
    timestamp: dayjs(date * 1000).unix(),
  };
  const author = committer;

  await git.commit({ fs, dir, message, committer, author });
};
const fetchHistoryFromPulumiStateBucket = async () => {

  try {
    let objects: _Object[] = [];
    let startAfter: string | undefined;
    while (true) {
      progressBar.update({
        log:
          `Retrieving checkpoints from ${(startAfter && `after ${startAfter}`) || "the beginning of history"}`
      }
      );
      const newObjects = (
        await client.send(
          new ListObjectsV2Command({
            Bucket: backendBucketName,
            Prefix: prefix,
            MaxKeys: bucketObjectsPageSize,
            StartAfter: startAfter,
          })
        )
      ).Contents!;
      if (!newObjects?.length) {
        if (!objects.length) {
          console.error(
            `Couldn't find any checkpoints in the pulumi state bucket ${backendBucketName}`
          );
          process.exit(1);
        }
        break;
      }
      objects = objects.concat(newObjects);
      startAfter = objects[objects.length - 1].Key;
    }

    progressBar.start(objects.length, 0);
    let checkpointFile: string;
    for await (const { Key: key } of objects) {
      if (key?.endsWith(".checkpoint.json") || key?.endsWith(".history.json")) {
        progressBar.update(++objectCounter, { log: ` Retrieved ${key.replace(prefix, '')}` });
        const file = await (
          await client.send(
            new GetObjectCommand({
              Bucket: backendBucketName,
              Key: key,
            })
          )
        ).Body!.transformToString();
        if (key?.endsWith(".checkpoint.json")) {
          checkpointFile = file;
        } else {
          await createCommitForCheckpoint(
            checkpointFile!,
            JSON.parse(file) as CheckpointMetadata
          );
        }
      } else {
        console.error(` Invalid file found in pulumi state bucket: ${key}`);
      }
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

console.debug("Cleaning previous local repository if existing");
fs.rmSync(dir, { force: true, recursive: true });
fs.mkdirSync(dir);
console.log(`Initializing git repository at ${dir}`);
git.init({ fs, dir }).then(() => {
  try {
    const stacks = execSync("pulumi stack ls").toString();
    currentStack = stacks
      .split("\n")
      .find((stack) => stack.includes("*"))
      ?.split(" ")[0]
      ?.replace("*", "");
    if (!currentStack) {
      console.error("Run pulumi stack select before running this script");
      process.exit(1);
    }

    backendBucketName = JSON.parse(
      execSync("pulumi whoami -vj").toString()
    )?.url?.replace("s3://", "");

    if (!backendBucketName) {
      console.error(
        "Couldn't find the S3 backend URL. Please run pulumi login first"
      );
      process.exit(1);
    }

    prefix = `.pulumi/history/${currentStack}/`;
    console.log(`Retrieving stack history checkpoints in bucket ${backendBucketName} with prefix ${prefix}`)

    fetchHistoryFromPulumiStateBucket().then(() => {
      progressBar.stop();
      console.info("Finished fetching history from pulumi state bucket");
      process.exit(0);
    });
  } catch (_e) {
    console.error("Please run this script in a pulumi project directory");
    process.exit(1);
  }
});
