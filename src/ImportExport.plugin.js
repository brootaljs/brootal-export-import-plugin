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
function addExportHeaders(res, name, type) {
  res.set('Cache-Control', 'max-age=0, no-cache, must-revalidate, proxy-revalidate');
  res.set('Last-Modified', new Date() + 'GMT');
  res.set('Content-Type', 'application/force-download');
  res.set('Content-Type', 'application/download');
  res.set('Content-Disposition', `attachment; filename=${ name }.${ type }`);
  
  switch (type) {
    case 'csv':
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Transfer-Encoding', 'binary');
      break
    case 'json':
    default:
      res.set('Content-Type', 'application/json');
      break;
  }
}

/**
 * Cascade export data from dependent services.
 * Calls Service.export on each of them and add result
 * to zip as separate files.
 */
async function cascade(Service, filter, type, req, res, zip) {
  const content = await Service.export(filter, req, res);

  let data;
  switch (type) {
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
  zip.addFile(`${ Service.name }.${ type }`, data);
  
  if (Service.exportWith) {
    await Promise.all(_.map(Service.exportWith || [], async exp => {
      let where = {};

      if (exp.foreignField) {
        where[exp.foreignField] = { "$in": _.map(content || [], ({ _id }) => _id) }
      } else if (exp.localField) {
        where._id = {
          "$in": _.reduce(content || [], (memo, item) => {
            return memo.concat(item[exp.localField]);
          }, [])
        }
      } else {
        throw new Error("Error in exportWith description")
      }

      const deepService = Service.app.services[exp.model];

      await cascade(deepService, { where }, deepService.exportType || 'json', req, res, zip)
    }))
  }
}

export default () => {
  return {
    staticMethods: {
      /**
       * Default export as json file. Can be redefined in service.
       */
      async export(filter, req, res) {
        let content;
        try {
          content = await this.find(filter);
        } catch (e) {
          console.log("DataTransfer.plugin (line : 137) | export | e : ", e);
        }

        if (res) addExportHeaders(res, this.name || 'data', 'json');

        return content;
      },
      /**
       * Default import of json file. Can be redefined in service.
       */
      async import(buffer, req, res) {
        let data;
        try {
          data = JSON.parse(buffer);
        } catch (e) {
          console.log("DataTransfer.plugin (line : 85) | import | e : ", e);
        }

        if (data) {
          try {
            await this.create(data)
          } catch (e) {
            console.log("DataTransfer.plugin (line : 92) | import | e : ", e);
          }
        }
      },
      /**
       * First step of export sequence. Checks export type and
       * initialize cascade or simple json export.
       */
      async exportProxy(filter = {}, req, res) {
        const type = (this.exportType || 'json').toLowerCase();

        if (type === 'zip') {
          const zip = new AdmZip();

          await cascade(this, filter, 'json', req, res, zip);

          const zipFileContents = zip.toBuffer();
          if (res) {
            res.set('Content-Disposition', `attachment; filename=${ this.name || 'data' }.zip`);
            res.set('Content-Type', 'application/zip');
            res.set('Content-Transfer-Encoding', 'binary');
            res.set('Content-Length', zipFileContents.length);
          }
          
          return zipFileContents;
        } else {
          return this.export(filter, req, res);
        }
      },
      /**
       * First step of export sequence. Reads "file" from request and
       * converts it to js Buffer. If export type zip - read it and
       * import all files as Service.import. If not - import input file
       * as json.
       */
      async importProxy(file, req, res) {
        const type = (this.exportType || 'json').toLowerCase();

        let buffer;
        try {
          buffer = await streamToBuffer(fs.createReadStream(file.tempFilePath))
        } catch (e) {
          console.log("Dataset.class (line : 305) | import | e : ", e);
        }

        if (buffer) {
          if (type === 'zip') {
            const zip = new AdmZip(buffer);
            const zipEntries = zip.getEntries();

            await Promise.all(_.map(zipEntries, async (zipEntry) => {
              const buf = zipEntry.name.split("\.");
              const ext = buf.pop();
              const modelName = buf[0];
              const Service = this.app.services[modelName];

              if (Service) await Service.import(zipEntry.getData(), req, res);
            }));
          } else {
            await this.import(buffer, req, res);
          }
        }
      }
    }
  }
}