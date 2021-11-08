import _ from 'lodash';

import { Parser as Json2csvParser  } from 'json2csv';
import AdmZip from 'adm-zip';
import MemoryStream from 'memorystream';

const fs = require('fs');

/**
 * Collect data from read stream and converts it to js Buffer
 */
function streamToBuffer(readStream) {
  return new Promise((resolve, reject) => {
    const writeStreamToBuffer = MemoryStream.createWriteStream();
    readStream
      .on("error", (error) => reject(error))
      .pipe(writeStreamToBuffer)
      .on("finish", async () => {
        try {
          resolve(writeStreamToBuffer.toBuffer());
        } catch (error) {
          reject(error);
        }
      });
  });
}

/**
 * Convert array of objects to csv file
 */
function packCSV(data, opts) {
  const json2csvParser = new Json2csvParser({
    fields: (opts && opts.structure) ? opts.structure : [ 'class', 'text' ]
  });

  return json2csvParser.parse(data);
}

/**
 * Add corresponding header to responce based on export type
 */
function addExportHeaders(res, name, type, contentLength) {
  res.set('Cache-Control', 'max-age=0, no-cache, must-revalidate, proxy-revalidate');
  res.set('Last-Modified', new Date() + 'GMT');
  res.set('Content-Type', 'application/force-download');
  res.set('Content-Type', 'application/download');
  res.set('Content-Disposition', `attachment; filename=${ name }.${ type }`);
  
  switch (type) {
    case 'zip':
      res.set('Content-Type', 'application/zip');
      res.set('Content-Transfer-Encoding', 'binary');
      res.set('Content-Length', contentLength);
      break;
    case 'csv':
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Transfer-Encoding', 'binary');
      break;
    case 'json':
    default:
      res.set('Content-Type', 'application/json');
      break;
  }
}

function deepFilter(data, exportRule) {
  let where = {};

  if (exportRule.foreignField) {
    where[exportRule.foreignField] = { "$in": _.map(data || [], ({ _id }) => _id) }
  } else if (exportRule.localField) {
    where._id = {
      "$in": _.reduce(data || [], (memo, item) => {
        return memo.concat(item[exportRule.localField]);
      }, [])
    }
  } else {
    throw new Error("Error in exportWith description")
  }

  return where;
}

/**
 * Cascade export data from dependent services.
 * Calls Service.export on each of them and add result
 * to zip as separate files.
 */
async function cascadeExport(Service, filter, req, res, zip) {
  let content;
  try {
    if (Service.export) {
      content = await Service.export(filter, req, res);
    } else {
      content = await Service.exportJSON(filter, req, res);
    }
  } catch (e) {
    console.log("ImportExport.plugin (line : 98) | cascadeExport | e : ", e);
    throw e;
  }

  let serviceType = (Service.exportType || 'json').toLowerCase();

  let data;
  switch (serviceType) {
    case 'zip':
      data = content;
      break;
    case 'csv':
      data = packCSV(content);
      break;
    case 'json':
    default:
      data = JSON.stringify(content);
      break;
  }
  
  if (Service.exportWith) {
    const innerZip = new AdmZip();

    innerZip.addFile(`${ Service.name }.${ serviceType }`, data);

    await Promise.all(_.map(Service.exportWith || [], async exp => {
      let where = deepFilter(content, exp);
      const deepService = Service.app.services[exp.model];

      await cascadeExport(deepService, { where }, req, res, innerZip);
    }));

    data = innerZip.toBuffer();

    serviceType = 'zip';
  }

  if (zip) zip.addFile(`${ Service.name }.${ serviceType }`, data);

  return data;
}

async function cascadeImport(Service, buffer, req, res, session) {
  if (Service.exportWith) {
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();

    await Promise.all(_.map(zipEntries, async (zipEntry) => {
      // zip created on osx full of useless garbage that breaks import process
      if (!zipEntry || !zipEntry.name) return;
      if (zipEntry.name[0] === '.') return;

      const buf = zipEntry.name.split("\.");
      const ext = buf.pop();
      const modelName = buf[0];
      const deepService = Service.app.services[modelName];

      if (deepService.import) {
        await deepService.import(zipEntry.getData(), req, res, session);
      } else {
        if (ext == 'zip') {
          await cascadeImport(deepService, zipEntry.getData(), req, res, session);
        } else {
          await deepService.importJSON(zipEntry.getData(), req, res, session);
        }
      }
    }));
    
  } else {
    if (Service.import) {
      await Service.import(buffer, req, res, session);
    } else {
      await Service.importJSON(buffer, req, res, session);
    }
  }
}

export default () => {
  return {
    staticMethods: {
      /**
       * Default export as json file.
       */
      async exportJSON(filter, req, res) {
        let content;
        try {
          content = await this.model.find(filter.where || {}, null, { autopopulate: false });
          // content = await this.find(filter);
        } catch (e) {
          console.log("DataTransfer.plugin (line : 137) | export | e : ", e);
        }

        if (res) addExportHeaders(res, this.name || 'data', 'json');

        return content;
      },
      /**
       * Default import of json file.
       */
      async importJSON(buffer, req, res, session) {
        let data;
        try {
          data = JSON.parse(buffer);
        } catch (e) {
          throw new Error(`${this.name} parse error: ${e.message}`);
        }

        if (data && data.length) {
          try {
            await this.create(data, { session });
          } catch (e) {
            throw new Error(`${this.name} create error: ${e.message}`);
          }
        }
      },
      /**
       * First step of export sequence. Checks export type and
       * initialize cascade or simple json export.
       */
      async exportProxy(filter = {}, req, res) {
        let type = (this.exportType || 'json').toLowerCase();
        if (this.exportWith) type = 'zip';
        // console.log("ImportExport.plugin (line : 238) | EXPORT PROXY | type: ", type);

        let data;
        try {
          data = await cascadeExport(this, filter, req, res);
        } catch (e) {
          console.log("ImportExport.plugin (line : 235) | exportProxy | e : ", e);
        }
        addExportHeaders(res, this.name, type, data.length);

        return data;
      },
      /**
       * First step of export sequence. Reads "file" from request and
       * converts it to js Buffer. If export type zip - read it and
       * import all files as Service.import. If not - import input file
       * as json.
       */
      async importProxy(file, req, res) {
        // Transactions demands MongoDB 4.0 and Mongoose 5.2.0
        let session;
        try {
          session = await this.app.datasources.db.startSession();
          session.startTransaction();
        } catch (e) {
          console.log("ImportExport.plugin (line : 246) | importProxy | e : ", e);
        }

        let buffer;
        try {
          buffer = await streamToBuffer(fs.createReadStream(file.tempFilePath))
        } catch (e) {
          console.log("Dataset.class (line : 305) | import | e : ", e);
        }

        if (buffer) {
          try {
            await cascadeImport(this, buffer, req, res, session);
          } catch (e) {
            console.log("ImportExport.plugin (line : 266) | abortTransaction | e : ", e);
            
            await session.abortTransaction();
            session.endSession();
            
            throw e;
          }
        }

        await session.commitTransaction();
        session.endSession();
      }
    }
  }
}