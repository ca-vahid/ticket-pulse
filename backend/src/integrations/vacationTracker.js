import axios from 'axios';
import logger from '../utils/logger.js';

const BASE_URL = 'https://api.vacationtracker.io';
const DEFAULT_LIMIT = 300;

class VacationTrackerClient {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('Vacation Tracker API key is required');
    }

    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    this.client.interceptors.response.use(
      response => response,
      error => {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        logger.error('Vacation Tracker API error:', {
          url: error.config?.url,
          status,
          message,
        });
        throw new Error(`Vacation Tracker API error (${status}): ${message}`);
      },
    );
  }

  async testConnection() {
    const response = await this.client.get('/v1/departments');
    return response.data?.status === 'ok';
  }

  async fetchLeaveTypes() {
    const response = await this.client.get('/v1/leave-types');
    return response.data?.data || [];
  }

  async fetchUsers() {
    const allUsers = [];
    let nextToken = null;

    do {
      const params = {
        status: 'ACTIVE',
        expand: 'location,department',
        limit: DEFAULT_LIMIT,
      };
      if (nextToken) params.nextToken = nextToken;

      const response = await this.client.get('/v1/users', { params });
      const data = response.data;
      if (data?.data) allUsers.push(...data.data);
      nextToken = data?.nextToken || null;
    } while (nextToken);

    return allUsers;
  }

  async fetchLeaves(startDate, endDate) {
    const allLeaves = [];
    let nextToken = null;

    do {
      const params = {
        startDate,
        endDate,
        status: 'APPROVED',
        expand: 'user,leaveType',
        limit: DEFAULT_LIMIT,
      };
      if (nextToken) params.nextToken = nextToken;

      const response = await this.client.get('/v1/leaves', { params });
      const data = response.data;
      if (data?.data) allLeaves.push(...data.data);
      nextToken = data?.nextToken || null;
    } while (nextToken);

    return allLeaves;
  }

  async fetchLocations() {
    const response = await this.client.get('/v1/locations');
    return response.data?.data || [];
  }

  async fetchDepartments() {
    const response = await this.client.get('/v1/departments');
    return response.data?.data || [];
  }
}

export default VacationTrackerClient;
