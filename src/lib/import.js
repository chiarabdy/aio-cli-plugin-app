/*
Copyright 2020 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

const aioLogger = require('@adobe/aio-lib-core-logging')('@adobe/aio-cli-plugin-app:import', { provider: 'debug' })
const path = require('path')
const fs = require('fs-extra')
const inquirer = require('inquirer')
const yaml = require('js-yaml')
const hjson = require('hjson')
const Ajv = require('ajv')

const AIO_FILE = '.aio'
const ENV_FILE = '.env'
const AIO_ENV_PREFIX = 'AIO_'
const AIO_ENV_SEPARATOR = '_'
const FILE_FORMAT_ENV = 'env'
const FILE_FORMAT_JSON = 'json'

function validateConfig (configJson) {
  const schema = require('../../schema/config.schema.json')
  const ajv = new Ajv({ allErrors: true })
  const validate = ajv.compile(schema)

  return { valid: validate(configJson), errors: validate.errors }
}

/**
 * Load a config file
 *
 * @param {string} fileOrBuffer the path to the config file or a Buffer
 */
function loadConfigFile (fileOrBuffer) {
  let contents
  if (typeof fileOrBuffer === 'string') {
    contents = fs.readFileSync(fileOrBuffer, 'utf-8')
  } else if (Buffer.isBuffer(fileOrBuffer)) {
    contents = fileOrBuffer.toString('utf-8')
  } else {
    contents = ''
  }

  contents = contents.trim()

  if (contents) {
    if (contents[0] === '{') {
      try {
        return { values: hjson.parse(contents), format: 'json' }
      } catch (e) {
        throw new Error('Cannot parse json')
      }
    } else {
      try {
        return { values: yaml.safeLoad(contents, { json: true }), format: 'yaml' }
      } catch (e) {
        throw new Error('Cannot parse yaml')
      }
    }
  }
  return { values: {}, format: 'json' }
}

/**
 * Pretty prints the json object as a string.
 * Delimited by 2 spaces.
 *
 * @param {object} json the json to pretty print
 */
function prettyPrintJson (json) {
  return JSON.stringify(json, null, 2)
}

/**
 * Confirmation prompt for overwriting, or merging a file if it already exists.
 *
 * @param {string} filePath the file to ovewrite
 * @return {object} ovewrite, merge, abort (properties, that are set to true if chosen)
 */
async function checkFileConflict (filePath) {
  if (fs.existsSync(filePath)) {
    const answer = await inquirer
      .prompt([
        {
          type: 'expand',
          message: `The file ${filePath} already exists:`,
          name: 'conflict',
          choices: [
            {
              key: 'o',
              name: 'Overwrite',
              value: 'overwrite'
            },
            {
              key: 'm',
              name: 'Merge',
              value: 'merge'
            },
            {
              key: 'x',
              name: 'Abort',
              value: 'abort'
            }
          ]
        }
      ])

    switch (answer.conflict) {
      case 'overwrite':
        return { overwrite: true }
      case 'merge':
        return { merge: true }
      case 'abort':
        return { abort: true }
      default:
        return {}
    }
  } else {
    return {}
  }
}

/**
 * Transform a json object to a flattened version. Any nesting is separated by the `separator` string.
 * For example, if you have the `_` separator string, flattening this:
 *
 * {
 *    foo: {
 *      bar: 'a',
 *      baz: {
 *        faz: 'b'
 *      }
 *    }
 * }
 *
 * const result = flattenObjectWithSeparator(json, {}, '', '_)
 * The result would then be:
 * {
 *    'foo_bar': 'a',
 *    'foo_baz_faz': 'b'
 * }
 *
 * Any underscores in the object key are escaped with an underscore.
 *
 * @param {object} json the json object to transform
 * @param {object} result the result object to initialize the function with
 * @param {string} prefix the prefix to add to the final key
 * @param {string} separator the separator string to separate the nested levels with
 */
function flattenObjectWithSeparator (json, result = {}, prefix = AIO_ENV_PREFIX, separator = AIO_ENV_SEPARATOR) {
  Object
    .keys(json)
    .forEach(key => {
      const _key = key.replace(/_/gi, '__') // replace any underscores in key with double underscores

      if (Array.isArray(json[key])) {
        result[`${prefix}${_key}`] = JSON.stringify(json[key])
        return result
      } else if (typeof (json[key]) === 'object') {
        flattenObjectWithSeparator(json[key], result, `${prefix}${_key}${separator}`)
      } else {
        result[`${prefix}${_key}`] = json[key]
        return result
      }
    })

  return result
}

/**
 * Merge .env data
 * (we don't want to go through the .env to json conversion)
 * Note that comments will not be preserved.
 *
 * @param {string} oldEnv existing env values
 * @param {newEnv} newEnv new env values (takes precedence)
 */
function mergeEnv (oldEnv, newEnv) {
  const result = {}
  const NEWLINES = /\n|\r|\r\n/

  function splitLine (line) {
    if (line.trim().startsWith('#')) { // skip comments
      return
    }

    const items = line.split('=')
    if (items.length >= 2) {
      const key = items.shift().trim() // pop first element
      const value = items.join('').trimStart() // join the rest

      result[key] = value
    }
  }

  aioLogger.debug(`mergeEnv - oldEnv:${oldEnv}`)
  aioLogger.debug(`mergeEnv - newEnv:${newEnv}`)

  oldEnv.split(NEWLINES).forEach(splitLine)
  newEnv.split(NEWLINES).forEach(splitLine)

  const mergedEnv = Object
    .keys(result)
    .map(key => `${key}=${result[key]}`)
    .join('\n')
  aioLogger.debug(`mergeEnv - mergedEnv:${mergedEnv}`)

  return mergedEnv
}

/**
 * Merge json data
 *
 * @param {string} oldData existing values
 * @param {newEnv} newData new values (takes precedence)
 */
function mergeJson (oldData, newData) {
  const { values: oldJson } = loadConfigFile(Buffer.from(oldData))
  const { values: newJson } = loadConfigFile(Buffer.from(newData))

  aioLogger.debug(`mergeJson - oldJson:${prettyPrintJson(oldJson)}`)
  aioLogger.debug(`mergeJson - newJson:${prettyPrintJson(newJson)}`)

  const mergedJson = prettyPrintJson({ ...oldJson, ...newJson })
  aioLogger.debug(`mergeJson - mergedJson:${mergedJson}`)

  return mergedJson
}

/**
 * Merge .env or json data
 *
 * @param {string} oldData the data to merge to
 * @param {string} newDdata the new data to merge from (these contents take precedence)
 * @param {*} fileFormat the file format of the data (env, json)
 */
function mergeData (oldData, newData, fileFormat) {
  aioLogger.debug(`mergeData - oldData: ${oldData}`)
  aioLogger.debug(`mergeData - newData:${newData}`)

  if (fileFormat === FILE_FORMAT_ENV) {
    return mergeEnv(oldData, newData)
  } else { // FILE_FORMAT_JSON default
    return mergeJson(oldData, newData)
  }
}

/**
 * Writes the data to file.
 * Checks for conflicts and gives options to overwrite, merge, or abort.
 *
 * @param {string} destination the file to write to
 * @param {string} data the data to write to disk
 * @param {object} flags] flags for file writing
 * @param {boolean} [flags.overwrite=false] set to true to overwrite the existing .env file
 * @param {boolean} [flags.merge=false] set to true to merge in the existing .env file (takes precedence over overwrite)
 * @param {boolean} [flags.interactive=false] set to true to prompt the user for file overwrite
 * @param {boolean} [flags.fileFormat=json] set the file format to write (defaults to json)
 */
async function writeFile (destination, data, flags = {}) {
  const { overwrite = false, merge = false, fileFormat = FILE_FORMAT_JSON, interactive = false } = flags
  aioLogger.debug(`writeFile - destination: ${destination} flags:${flags}`)
  aioLogger.debug(`writeFile - data: ${data}`)

  let answer = { overwrite, merge } // for non-interactive, get from the flags

  if (interactive) {
    answer = await checkFileConflict(destination)
    aioLogger.debug(`writeEnv - answer (interactive): ${JSON.stringify(answer)}`)
  }

  if (answer.abort) {
    return
  }

  if (answer.merge) {
    if (fs.existsSync(destination)) {
      const oldData = fs.readFileSync(destination, 'utf-8')
      data = mergeData(oldData, data, fileFormat)
    }
  }

  return fs.writeFile(destination, data, {
    flag: (answer.overwrite || answer.merge) ? 'w' : 'wx'
  })
}

/**
 * Writes the json object as AIO_ env vars to the .env file in the specified parent folder.
 *
 * @param {object} json the json object to transform and write to disk
 * @param {string} parentFolder the parent folder to write the .env file to
 * @param {object} flags] flags for file writing
 * @param {boolean} [flags.overwrite=false] set to true to overwrite the existing .env file
 * @param {boolean} [flags.merge=false] set to true to merge in the existing .env file (takes precedence over overwrite)
 * @param {boolean} [flags.interactive=false] set to true to prompt the user for file overwrite
 */
async function writeEnv (json, parentFolder, flags) {
  aioLogger.debug(`writeEnv - json: ${JSON.stringify(json)} parentFolder:${parentFolder} flags:${flags}`)

  const destination = path.join(parentFolder, ENV_FILE)
  aioLogger.debug(`writeEnv - destination: ${destination}`)

  const resultObject = flattenObjectWithSeparator(json)
  aioLogger.debug(`convertJsonToEnv - flattened and separated json: ${prettyPrintJson(resultObject)}`)

  const data = Object
    .keys(resultObject)
    .map(key => `${key}=${resultObject[key]}`)
    .join('\n')
  aioLogger.debug(`writeEnv - data: ${data}`)

  return writeFile(destination, data, { ...flags, fileFormat: FILE_FORMAT_ENV })
}

/**
 * Writes the json object to the .aio file in the specified parent folder.
 *
 * @param {object} json the json object to write to disk
 * @param {string} parentFolder the parent folder to write the .aio file to
 * @param {object} flags] flags for file writing
 * @param {boolean} [flags.overwrite=false] set to true to overwrite the existing .env file
 * @param {boolean} [flags.merge=false] set to true to merge in the existing .env file (takes precedence over overwrite)
 * @param {boolean} [flags.interactive=false] set to true to prompt the user for file overwrite
 */
async function writeAio (json, parentFolder, flags) {
  aioLogger.debug(`writeAio - parentFolder:${parentFolder} flags:${flags}`)
  aioLogger.debug(`writeAio - json: ${prettyPrintJson(json)}`)

  const destination = path.join(parentFolder, AIO_FILE)
  aioLogger.debug(`writeAio - destination: ${destination}`)

  const data = prettyPrintJson(json)
  return writeFile(destination, data, flags)
}

/**
 * Transform runtime object value to what this plugin expects (single runtime namespace).
 *
 * @example
 * from:
 * {
 *   "namespaces": [
 *     {
 *       "name": "abc",
 *       "auth": "123"
 *     }
 *   ]
 * }
 * to:
 * {
 *   "namespace": "abc",
 *   "auth": "123"
 * }
 *
 * @param {object} runtime the runtime value to transform
 * @returns {object} the transformed runtime object
 * @private
 */
function transformRuntime (runtime) {
  const newRuntime = (runtime.namespaces.length > 0) ? runtime.namespaces[0] : {}
  if (newRuntime.name) {
    newRuntime.namespace = newRuntime.name
    delete newRuntime.name
  }

  return newRuntime
}

/**
 * Transforms a credentials array to an object, to what this plugin expects.
 * Enrich with ims_org_id if it is a jwt credential.
 *
 * @example
 * from:
 * [{
 *   "id": "17561142",
 *   "name": "Project Foo",
 *   "integration_type": "oauthweb",
 *   "oauth2": {
 *       "client_id": "XYXYXYXYXYXYXYXYX",
 *       "client_secret": "XYXYXYXYZZZZZZ",
 *       "redirect_uri": "https://test123"
 *   }
 * }]
 * to:
 * {
 *   "Project Foo": {
 *       "client_id": "XYXYXYXYXYXYXYXYX",
 *       "client_secret": "XYXYXYXYZZZZZZ",
 *       "redirect_uri": "https://test123"
 *   }
 * }
 *
 * @param {Array} credentials array from Downloadable File Format
 * @returns {object} credentials object
 * @private
 */
function transformCredentials (credentials, imsOrgId) {
  // find jwt credential
  const credential = credentials.find(credential => typeof credential.jwt === 'object')

  // enrich jwt credentials with ims org id
  if (credential && credential.jwt && !credential.jwt.ims_org_id) {
    aioLogger.debug('adding ims_org_id to $ims.jwt config')
    credential.jwt.ims_org_id = imsOrgId
  }

  return credentials.reduce((acc, credential) => {
    // the json schema enforces either jwt OR oauth2 keys in a credential
    let value = credential.oauth2
    if (!value) {
      value = credential.jwt
    }

    const name = credential.name.replace(/ /gi, '_') // replace any spaces with underscores
    acc[name] = value

    return acc
  }, {})
}

/**
 * Import a downloadable config and write to the appropriate .env (credentials) and .aio (non-credentials) files.
 *
 * @param {string} configFileLocation the path to the config file to import
 * @param {string} [destinationFolder=the current working directory] the path to the folder to write the .env and .aio files to
 * @param {object} flags] flags for file writing
 * @param {boolean} [flags.overwrite=false] set to true to overwrite the existing .env file
 * @param {boolean} [flags.merge=false] set to true to merge in the existing .env file (takes precedence over overwrite)
*/
async function importConfigJson (configFileLocation, destinationFolder = process.cwd(), flags = {}) {
  aioLogger.debug(`importConfigJson - configFileLocation: ${configFileLocation} destinationFolder:${destinationFolder} flags:${flags}`)

  const { values: config, format } = loadConfigFile(configFileLocation)
  const { valid: configIsValid, errors: configErrors } = validateConfig(config)

  aioLogger.debug(`importConfigJson - format: ${format} config:${prettyPrintJson(config)} `)

  if (!configIsValid) {
    const message = `Missing or invalid keys in config: ${JSON.stringify(configErrors, null, 2)}`
    throw new Error(message)
  }

  const { runtime, credentials } = config.project.workspace.details

  await writeEnv({
    runtime: transformRuntime(runtime),
    $ims: transformCredentials(credentials, config.project.org.ims_org_id)
  }, destinationFolder, flags)

  // remove the credentials
  delete config.project.workspace.details.runtime
  delete config.project.workspace.details.credentials

  return writeAio(config, destinationFolder, flags)
}

module.exports = {
  validateConfig,
  loadConfigFile,
  writeAio,
  writeEnv,
  flattenObjectWithSeparator,
  importConfigJson
}
